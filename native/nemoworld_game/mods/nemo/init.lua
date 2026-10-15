-- Original NemoWorld Lua mod. All mutable world records belong to the Node service.
local http = core.request_http_api()
if not http then error('nemo requires secure.http_mods = nemo and a cURL-enabled Luanti server') end
local endpoint = core.settings:get('nemo_bridge_url') or 'http://127.0.0.1:3999'
local mod_key = core.settings:get('nemo_bridge_key')
if not mod_key or #mod_key < 32 then error('nemo_bridge_key must match the local bridge key') end
core.set_mapgen_setting('mg_name', 'singlenode', true)
local size = 48
local paired = {}
local mission_evidence = {}
local projected = {}
local busy = {}
local motion = {}
local reconciled = false
local emerging = false
local active_world = nil
local motion_clock = 0
local sync_elapsed = 0
local move_cooldown = 0.16
local motion_threshold = 0.55
local kinds = {'stone','wood','glass','brick','sand','grass','path','clay','slate'}
local names = {}
for _,kind in ipairs(kinds) do names[kind]=true end
local terrain_types = {meadow=true,tree=true,water=true,garden=true,path=true,plaza=true,grass=true}
local markers = {}
local gate_markers = {}
local project_scene = dofile(core.get_modpath('nemo')..'/scene.lua')
local resume_player
local native_logins={}
local pairing_form = 'nemo:pairing'

local function show_pairing(name, reason)
  core.show_formspec(name,pairing_form,'formspec_version[4]size[11,8]'..
    'label[0.5,0.6;Sign in to NemoWorld]'..
    'textarea[0.5,1.1;10,1.6;;;'..core.formspec_escape('Use your NemoWorld account. Choose your saved human character and return automatically on this Luanti login. No browser or pairing code is needed. The connection is remembered privately on this computer.')..']'..
    'field[0.5,3;10,0.8;native_email;NemoWorld email;]'..
    'pwdfield[0.5,4.2;10,0.8;native_password;NemoWorld password]'..
    'button[0.5,5.3;4.8,0.8;native_signin;Sign in]'..
    'button_exit[5.6,5.3;4.8,0.8;later;Wait here]'..
    'textarea[0.5,6.5;10,1;;;'..core.formspec_escape(reason or 'Your password is used only for sign-in. It is not saved in the game or connection cache.')..']')
end
local function show_characters(name,session)
  local choices={}
  for _,agent in ipairs(session.agents) do choices[#choices+1]=core.formspec_escape(agent.name..' · '..agent.world_id) end
  core.show_formspec(name,'nemo:characters','formspec_version[4]size[11,5]label[0.5,0.6;Choose your human character]'..
    'dropdown[0.5,1.4;10,0.8;character;'..table.concat(choices,',')..';1;true]'..
    'button[0.5,2.8;10,0.8;native_connect;Enter world]'..
    'label[0.5,4;This choice will be restored automatically on your next native login.]')
end

local function suspend_player(player, state)
  if not player or not player.set_physics_override then return end
  if not state.physics then
    local current = player:get_physics_override()
    state.physics = {speed=current.speed, jump=current.jump, gravity=current.gravity}
  end
  player:set_physics_override({speed=0, jump=0, gravity=0})
end

local function inside(pos)
  return pos and pos.x >= 0 and pos.x < size and pos.z >= 0 and pos.z < size and pos.y >= 0 and pos.y <= 7
    and pos.x == math.floor(pos.x) and pos.y == math.floor(pos.y) and pos.z == math.floor(pos.z)
end
local function message(name, text)
  if core.get_player_by_name(name) then core.chat_send_player(name, '[NemoWorld] ' .. text) end
end
local function request(path, payload, callback)
  -- Bind the request to the pairing that originated it. A delayed old callback must not act as
  -- a newly paired avatar with the same Luanti player name.
  if path ~= '/native/pair' and payload.player then payload.pair_id = paired[payload.player] end
  http.fetch({url=endpoint .. path, method='POST', data=core.write_json(payload), timeout=5,
    extra_headers={'Content-Type: application/json', 'X-Nemo-Mod-Key: ' .. mod_key}}, function(response)
    local parsed, body = false, nil
    if response and response.succeeded and type(response.data) == 'string' then
      parsed, body = pcall(core.parse_json, response.data)
    end
    -- A malformed success response must still call back. In particular, sync() clears its busy
    -- flag only inside this callback; leaving it pending would stop future world refreshes.
    if not parsed or type(body) ~= 'table' then callback(false, 'Bridge unavailable or invalid response.', response and response.code)
    elseif response.code < 200 or response.code >= 300 then callback(false, body.error or 'Action refused.', response.code)
    else callback(true, body) end
  end)
end
local function paired_request(name, path, payload, callback)
  local state = motion[name]
  if not paired[name] or not state then return false end
  request(path, payload, function(...)
    -- A response from the previous avatar must never appear in a newly paired player's chat.
    if not paired[name] or motion[name] ~= state then return end
    callback(...)
  end)
  return true
end
local function key(pos) return pos.x .. ':' .. pos.y .. ':' .. pos.z end
local sync
local creative = dofile(core.get_modpath('nemo')..'/creative.lua')({
  scene=function(name) local state=motion[name];return paired[name] and state and state.ready and state.scene or nil end,
  request=paired_request,sync=function(name) sync(name) end,connect=show_pairing,message=message,
})
local function stop_player(player)
  if player and player.set_velocity then player:set_velocity({x=0, y=0, z=0}) end
end
local function stop_horizontal(player)
  if player and player.set_velocity then
    local velocity=player.get_velocity and player:get_velocity() or {y=0}
    player:set_velocity({x=0,y=velocity.y,z=0})
  end
end
local function set_anchor(name, player, pos, release)
  if not player or not pos then return end
  -- Nemo z is the standing layer. The native terrain's top is -0.5; the player
  -- origin is offset by its collision-box minimum, not two metres above its feet.
  local properties=player.get_properties and player:get_properties() or {}
  local collision_min=properties.collisionbox and properties.collisionbox[2] or 0
  local target = {x=pos.x, y=(pos.z or 0)-0.5-collision_min+0.01, z=pos.y}
  local current = player:get_pos()
  local state = motion[name] or {}
  local dx, dz = current.x - target.x, current.z - target.z
  -- A sync is a reconciliation point, not a heartbeat teleport. Small differences are normal
  -- while Luanti settles a step and are left alone to avoid visible jitter.
  local changed_height=state.ready and state.anchor and math.abs(state.anchor.y-target.y)>0.05
  local horizontal_error=math.max(math.abs(dx),math.abs(dz))
  -- Leave a physically settled or jumping player alone on heartbeats. A confirmed
  -- walking step may already be within half a tile of its new authoritative centre.
  if not state.ready or changed_height or horizontal_error>0.55 or current.y<target.y-0.3 or current.y>target.y+2 then
    local corrected={x=target.x,y=target.y,z=target.z}
    if state.ready and not changed_height and current.y>=target.y-0.1 and current.y<=target.y+2 then corrected.y=current.y end
    player:set_pos(corrected)
    stop_player(player)
  end
  state.anchor = {x=target.x, y=target.y, z=target.z}
  if not state.ready then
    state.ready = true
    if state.physics and player.set_physics_override then player:set_physics_override(state.physics) end
    core.close_formspec(name, pairing_form)
    message(name, 'Shared frontier loaded. Walk normally; saved actions follow NemoWorld permissions.')
  end
  if release then
    state.in_flight = false
    state.last_direction = nil
  end
  motion[name] = state
end
local function request_move(name, direction)
  local state = motion[name] or {}
  local generation = state.generation
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  if state.in_flight then return false, 'Movement is still being confirmed.' end
  if motion_clock - (state.last_request or -math.huge) < move_cooldown then return false, 'Movement is cooling down.' end
  state.in_flight = true
  state.last_request = motion_clock
  state.last_direction = direction
  motion[name] = state
  request('/native/action', {player=name, action='move', direction=direction}, function(ok, data)
    if motion[name] ~= state or state.generation ~= generation then return end
    if not ok then
      state.in_flight = false
      state.last_direction = nil
      message(name, data)
      sync(name, false)
    else
      -- Keep the gate closed until state reconciliation proves where the authoritative avatar is.
      sync(name, true)
    end
  end)
  return true
end
sync = function(name, release_motion)
  if not paired[name] then return end
  if busy[name] or emerging then
    local state = motion[name] or {}
    state.sync_after = true
    state.release_after = state.release_after or release_motion
    motion[name] = state
    return
  end
  local state = motion[name]
  local generation = state and state.generation
  busy[name] = state
  request('/native/state', {player=name}, function(ok, data, code)
    if motion[name] ~= state or state.generation ~= generation then
      -- A leave/re-pair may have installed a newer state. Release only this callback's slot;
      -- never clear a newer request's busy marker.
      if busy[name] == state then busy[name] = nil end
      return
    end
    busy[name] = nil
    if not ok then
      if code == 401 or code == 403 then
        paired[name] = nil
        state.ready = false
        suspend_player(core.get_player_by_name(name), state)
        resume_player(name)
      end
      if code ~= 401 then
        local state = motion[name]
        if state then state.release_after = state.release_after or release_motion end
      end
      message(name, data)
      return
    end
    local function apply()
      if not paired[name] or motion[name] ~= state or state.generation ~= generation then
        emerging = false
        if paired[name] then sync(name) end
        return
      end
      if active_world ~= data.world_id then
        active_world = data.world_id
        reconciled = false
      end
      core.load_area({x=0,y=-1,z=0}, {x=47,y=7,z=47})
      for _, tile in ipairs(data.terrain or {}) do
        if tile.x >= 0 and tile.x < 48 and tile.y >= 0 and tile.y < 48 then
          local type_name = terrain_types[tile.type] and tile.type or 'meadow'
          local pos = {x=tile.x,y=-1,z=tile.y}
          if core.get_node(pos).name ~= 'nemo:terrain_' .. type_name then core.set_node(pos,{name='nemo:terrain_' .. type_name}) end
        end
      end
      local next_nodes = project_scene(data)
      for _, block in ipairs(data.blocks or {}) do
        local pos = {x=block.x, y=block.z, z=block.y}
        if inside(pos) and names[block.type] then
          local id = key(pos); next_nodes[id] = {pos=pos, type=block.type}
        end
      end
      for _,node in pairs(next_nodes) do
        if core.get_node(node.pos).name~='nemo:'..node.type then core.set_node(node.pos,{name='nemo:'..node.type}) end
      end
      if not reconciled then
        -- A Luanti world may have persisted a node removed while this server was offline.
        for x=0,47 do for z=0,47 do for y=0,7 do
          local pos={x=x,y=y,z=z}
          local node=core.get_node(pos).name
          if node:sub(1,5) == 'nemo:' and not next_nodes[key(pos)] then core.set_node(pos,{name='air'}) end
        end end end
        reconciled = true
      else
        for id, old in pairs(projected) do
          if not next_nodes[id] then core.set_node(old.pos, {name='air'}) end
        end
      end
      projected = next_nodes
      state.scene=data
      local show_build_start=not state.build_onboarding_shown and data.creative and not data.creative.my_plot
      state.build_onboarding_shown=true
      for _,marker in pairs(gate_markers) do if marker and marker:get_pos() then marker:remove() end end
      gate_markers={}
      local compass={up='North',down='South',left='West',right='East'}
      for _,gate in ipairs(data.gates or {}) do
        local marker=core.add_entity({x=gate.x,y=4.6,z=gate.y},'nemo:gate_label')
        if marker then
          marker:set_properties({nametag=(compass[gate.direction] or gate.direction)..' · '..gate.target_world_id..(gate.exists and ' · open' or ' · unopened')})
          gate_markers[gate.direction]=marker
        end
      end
      local seen = {}
      for _, resident in ipairs(data.participants or {}) do
        if resident.id and resident.x and resident.y then
          seen[resident.id] = true
          local marker = markers[resident.id]
          if not marker or not marker:get_pos() then
            marker = core.add_entity({x=resident.x,y=math.max(1.5,(resident.z or 0)+1.5),z=resident.y},'nemo:resident')
            markers[resident.id] = marker
          end
          if marker then
            marker:set_pos({x=resident.x,y=math.max(1.5,(resident.z or 0)+1.5),z=resident.y})
            marker:set_properties({nametag=(resident.kind == 'agent' and 'AI · ' or '') .. (resident.name or 'Resident')})
          end
        end
      end
      for id, marker in pairs(markers) do
        if not seen[id] then if marker and marker:get_pos() then marker:remove() end; markers[id] = nil end
      end
      local player = core.get_player_by_name(name)
      local release_now = release_motion or (state and state.release_after and not state.sync_after)
      if player and data.player then
        set_anchor(name, player, data.player, release_now)
        if player.hud_add then
          local plot=data.creative and data.creative.my_plot
          local land_hint=plot and ('Your plot: '..plot.x..'–'..(plot.x+5)..', '..plot.y..'–'..(plot.y+5)) or 'Choose a free building plot: /nemo_build'
          local text=data.world_id..' · Tile '..data.player.x..','..data.player.y..' · '..#(data.participants or {})..' other residents · '..#(data.blocks or {})..' saved blocks\n'..land_hint..'\nCreative materials: free and reusable · /nemo_build for tools, plots and blueprints\n/nemo_chat for conversation · Walk to a labelled gate to cross an opened area'
          if state.hud then player:hud_change(state.hud,'text',text)
          else state.hud=player:hud_add({type='text',position={x=0,y=0},offset={x=18,y=95},alignment={x=1,y=1},number=0xF5EED9,text=text,z_index=100}) end
        end
      elseif data.player and release_now and state then
        -- The server confirmed the step, but a player object may have vanished during sync (or
        -- the server-only smoke probe may use a synthetic name). Do not strand motion in flight.
        state.in_flight = false
        state.last_direction = nil
      end
      if show_build_start and state.ready and player then creative.show(name,'Choose a free plot and enter its purpose before placing blocks. A collaboration grant also permits building on its specified plot.') end
      local follow_up = state and state.sync_after
      local follow_release = state and state.release_after
      if follow_up then state.sync_after = nil end
      if follow_up then state.release_after = nil; sync(name, follow_release)
      elseif state then state.release_after = nil end
    end
    if reconciled then apply() else
      emerging = true
      core.emerge_area({x=0,y=-1,z=0},{x=47,y=7,z=47},function(_, action, remaining)
        if remaining == 0 then emerging = false; apply() end
      end)
    end
  end)
end
local function act(name, action, pos, block_type)
  if not paired[name] then message(name, 'Sign in with /nemo_connect first.'); return end
  if pos and not inside(pos) then message(name, 'Outside the 48 by 48 sector or block layers 0 to 7.'); return end
  paired_request(name, '/native/action', {player=name, action=action, pos=pos, type=block_type}, function(ok, data)
    if not ok then
      message(name,data)
      if action=='place' then creative.show(name,data) end
    else sync(name) end
  end)
end

core.register_node('nemo:ground', {description='NemoWorld ground', tiles={'nemo_ground.png'}, diggable=false, pointable=true,
  groups={immortal=1}, on_punch=function() end})
local ground_textures={meadow='nemo_cc0_grass.jpg',tree='nemo_cc0_grass.jpg',grass='nemo_cc0_grass.jpg',
  garden='nemo_cc0_soil.jpg',path='nemo_cc0_soil.jpg^[colorize:#d2c08a:110',plaza='nemo_cc0_concrete.jpg',water='nemo_terrain_water.png'}
for type_name in pairs(terrain_types) do
  core.register_node('nemo:terrain_' .. type_name, {description='NemoWorld ' .. type_name .. ' terrain', tiles={ground_textures[type_name]},
    diggable=false, groups={immortal=1}, on_punch=function() end})
end
core.register_entity('nemo:resident', {initial_properties={physical=false,pointable=false,static_save=false,
  visual='cube',visual_size={x=0.55,y=1.05},textures={'nemo_resident.png','nemo_resident.png','nemo_resident.png','nemo_resident.png','nemo_resident.png','nemo_resident.png'}}})
core.register_node('nemo:boundary', {description='Finite sector boundary', tiles={'nemo_boundary.png'}, diggable=false,
  groups={immortal=1}, on_punch=function() end})
local block_textures={stone='nemo_cc0_rock.jpg',wood='nemo_cc0_wood.jpg',glass='nemo_glass.png',
  brick='nemo_cc0_terracotta.jpg',sand='nemo_cc0_soil.jpg^[colorize:#d3c28d:130',grass='nemo_cc0_grass.jpg',
  path='nemo_cc0_soil.jpg',clay='nemo_cc0_terracotta.jpg^[colorize:#ba7957:80',slate='nemo_cc0_rock.jpg^[colorize:#536478:110'}
for _,kind in ipairs(kinds) do
  core.register_node('nemo:' .. kind, {description='NemoWorld ' .. kind, tiles={block_textures[kind]},
    diggable=false, groups={immortal=1}, on_punch=function(pos, node, puncher)
      if puncher and puncher:is_player() then act(puncher:get_player_name(), 'remove', pos) end
    end})
  core.register_craftitem('nemo:place_' .. kind, {description=kind..' · free reusable creative tool', inventory_image=block_textures[kind],stack_max=1,
    on_secondary_use=function(itemstack,user) if user then creative.show(user:get_player_name()) end;return itemstack end,
    on_place=function(itemstack, placer, pointed)
      if placer and placer:is_player() and pointed and pointed.type == 'node' then
        act(placer:get_player_name(), 'place', pointed.above, kind)
      end
      return itemstack
    end})
end
core.register_on_generated(function(minp, maxp)
  local xmin, xmax = math.max(minp.x, 0), math.min(maxp.x, size - 1)
  local zmin, zmax = math.max(minp.z, 0), math.min(maxp.z, size - 1)
  if minp.y <= -1 and maxp.y >= -1 then
    for x=xmin,xmax do for z=zmin,zmax do core.set_node({x=x,y=-1,z=z}, {name='nemo:ground'}) end end
  end
  for y=math.max(0,minp.y),math.min(3,maxp.y) do
    for x=math.max(-1,minp.x),math.min(48,maxp.x) do
      if minp.z <= -1 and maxp.z >= -1 then core.set_node({x=x,y=y,z=-1},{name='nemo:boundary'}) end
      if minp.z <= 48 and maxp.z >= 48 then core.set_node({x=x,y=y,z=48},{name='nemo:boundary'}) end
    end
    for z=math.max(0,minp.z),math.min(47,maxp.z) do
      if minp.x <= -1 and maxp.x >= -1 then core.set_node({x=-1,y=y,z=z},{name='nemo:boundary'}) end
      if minp.x <= 48 and maxp.x >= 48 then core.set_node({x=48,y=y,z=z},{name='nemo:boundary'}) end
    end
  end
end)
local function finish_connection(name, previous, pairing_attempt, ok, data)
    if motion[name] ~= previous or not motion[name] or motion[name].pairing_attempt ~= pairing_attempt then return end
    if ok and type(data.pair_id) == 'string' and #data.pair_id == 32 then
      local next_generation = ((previous and previous.generation) or 0) + 1
      motion[name] = {anchor={x=24,y=2,z=24}, last_request=-math.huge, generation=next_generation, physics=previous.physics, hud=previous.hud}
      suspend_player(core.get_player_by_name(name), motion[name])
      paired[name] = data.pair_id
      native_logins[name]=nil
      core.close_formspec(name,'nemo:characters')
      mission_evidence[name] = nil
      creative.clear(name)
      busy[name] = nil
      message(name, 'Connected to your saved character.'); sync(name)
    else
      local reason = ok and 'Bridge connection response was invalid.' or data
      message(name, reason)
      show_pairing(name, reason)
    end
end
local function connection_attempt(name)
  local previous=motion[name]
  if not previous then return end
  previous.pairing_attempt=(previous.pairing_attempt or 0)+1
  previous.retry_resume=false
  return previous,previous.pairing_attempt
end
local function connect_character(name,agent_id)
  local session=native_logins[name]
  if not session then show_pairing(name,'Sign in to choose your character.');return end
  native_logins[name]=nil
  local previous,attempt=connection_attempt(name)
  request('/native/connect',{player=name,login_id=session.login_id,agent_id=agent_id},function(ok,data)
    finish_connection(name,previous,attempt,ok,data)
  end)
end
resume_player=function(name)
  local previous,attempt=connection_attempt(name)
  if not previous then return end
  previous.resume_pending=true
  request('/native/resume',{player=name},function(ok,data,code)
    if motion[name]~=previous or previous.pairing_attempt~=attempt then return end
    previous.resume_pending=false
    if ok then finish_connection(name,previous,attempt,ok,data)
    else
      previous.retry_resume=code~=401 and code~=404
      show_pairing(name,data)
    end
  end)
end
core.register_on_joinplayer(function(player)
  local name = player:get_player_name()
  motion[name] = {anchor={x=24,y=2,z=24}, last_request=-math.huge}
  suspend_player(player, motion[name])
  player:set_pos({x=24,y=2,z=24})
  -- The old path emerged terrain only after pairing; a new arrival could fall through an empty
  -- singlenode map. Generate the neutral render-cache floor before any account is connected.
  core.emerge_area({x=0,y=-1,z=0},{x=47,y=7,z=47})
  local inventory = player:get_inventory()
  local kept={}
  for _,stack in ipairs(inventory:get_list('main') or {}) do
    if not stack:is_empty() and not stack:get_name():match('^nemo:place_') then kept[#kept+1]=stack end
  end
  local tools={}
  for _,kind in ipairs(kinds) do tools[#tools+1]=ItemStack('nemo:place_'..kind) end
  for _,stack in ipairs(kept) do tools[#tools+1]=stack end
  inventory:set_size('main',math.max(36,9*math.ceil(#tools/9)))
  inventory:set_list('main',tools)
  if player.hud_set_hotbar_itemcount then player:hud_set_hotbar_itemcount(9) end
  if player.set_inventory_formspec then player:set_inventory_formspec('formspec_version[4]size[11,7]label[0.5,0.5;Free creative tools · /nemo_build for plots and blueprints]list[current_player;main;0.5,1;9,4;]listring[]') end
  message(name,'Connecting your saved character. Free tools: /nemo_build. Click ground to place; punch saved blocks to remove.')
  show_pairing(name,'Restoring your saved connection...')
  resume_player(name)
end)
core.register_on_player_receive_fields(function(player,formname,fields)
  local name=player:get_player_name()
  if formname=='nemo:characters' then
    local session=native_logins[name]
    if fields.native_connect and session then
      local agent=session.agents[tonumber(fields.character or '') or 0]
      if agent then connect_character(name,agent.id) else show_characters(name,session) end
    end
    return true
  end
  if formname~=pairing_form then return false end
  if fields.native_signin or fields.key_enter_field=='native_password' then
    local previous,attempt=connection_attempt(name)
    local payload={player=name,email=fields.native_email or '',password=fields.native_password or ''}
    fields.native_password=nil
    request('/native/login',payload,function(ok,data)
      payload.password=nil
      if motion[name]~=previous or previous.pairing_attempt~=attempt then return end
      if not ok then show_pairing(name,data);return end
      native_logins[name]={login_id=data.login_id,agents=data.agents}
      if #data.agents==1 then connect_character(name,data.agents[1].id)
      else show_characters(name,native_logins[name]) end
    end)
  end
  return true
end)
core.register_chatcommand('nemo_connect', {description='Sign in or choose a different NemoWorld account', func=function(name)
  show_pairing(name)
  return true, 'Sign in here to connect your saved human character.'
end})
core.register_on_leaveplayer(function(player)
  local name = player:get_player_name()
  paired[name] = nil
  mission_evidence[name] = nil
  busy[name] = nil
  motion[name] = nil
  creative.clear(name)
  native_logins[name]=nil
end)
core.register_chatcommand('nemo_pair', {params='CODE', description='Pair this player to an operator-owned human avatar', func=function(name, code)
  if not code:match('^[a-f0-9]+$') then return false, 'Invalid pairing code.' end
  local previous = motion[name]
  if not previous then
    -- The native smoke probe invokes chat commands with a synthetic player name and does not
    -- run Luanti's join callback first. Keep the same session guard for that path.
    previous = {anchor={x=24,y=2,z=24}, last_request=-math.huge, generation=0}
    motion[name] = previous
  end
  local pairing_attempt = (previous and previous.pairing_attempt or 0) + 1
  if previous then previous.pairing_attempt = pairing_attempt end
  request('/native/pair', {player=name, code=code}, function(ok, data)
    finish_connection(name,previous,pairing_attempt,ok,data)
  end)
  return true, 'Pairing request sent.'
end})
core.register_chatcommand('nemo_signout',{description='Forget this computer’s saved NemoWorld connection',func=function(name)
  if not paired[name] then show_pairing(name);return false,'No active connection.' end
  paired_request(name,'/native/forget',{player=name},function(ok,data)
    if not ok then message(name,data);return end
    paired[name]=nil;native_logins[name]=nil
    local state=motion[name];state.ready=false;state.retry_resume=false
    suspend_player(core.get_player_by_name(name),state)
    show_pairing(name,'Signed out. This computer will not reconnect until you sign in again.')
  end)
  return true,'Signing out.'
end})
core.register_chatcommand('nemo_move', {params='up|down|left|right', description='Request one authoritative step', func=function(name, direction)
  if not ({up=true,down=true,left=true,right=true})[direction] then return false, 'Choose up, down, left or right.' end
  local accepted, reason = request_move(name, direction)
  if not accepted then return false, reason end
  return true, 'Step requested.'
end})
-- Mission work over the same records the browser reads. The pairing credential selects the human
-- avatar; the bridge resolves the sender from NemoWorld, never from a recipient typed in chat.
core.register_chatcommand('nemo_missions', {params='', description='List open mission tasks and your active claim', func=function(name)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  paired_request(name, '/native/missions', {player=name}, function(ok, data)
    if not ok then core.log('action','NEMO_MISSIONS_ERROR '..tostring(data)); message(name, data); return end
    local ids = {}
    for _, task in ipairs(data.tasks or {}) do ids[#ids+1] = task.id end
    local claim = data.active_claim and data.active_claim.id or 'none'
    core.log('action','NEMO_MISSIONS_RESULT tasks='..table.concat(ids,',')..' claim='..claim)
    message(name, 'Missions: '..(#ids > 0 and table.concat(ids, ', ') or 'none')..' (claim '..claim..')')
  end)
  return true, 'Reading the mission directory.'
end})
core.register_chatcommand('nemo_claim', {params='TASK_ID', description='Claim one open mission task', func=function(name, task_id)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  if not task_id or task_id == '' then return false, 'Give a task id from /nemo_missions.' end
  paired_request(name, '/native/claim', {player=name, task_id=task_id}, function(ok, data)
    if not ok then core.log('action','NEMO_CLAIM_ERROR '..tostring(data)); message(name, data); return end
    -- Repeating the same active claim is an idempotent read. Keep notes the player has already
    -- entered; a genuinely new claim still starts with a clean evidence draft.
    if not mission_evidence[name] or mission_evidence[name].claim_id ~= data.claim.id then
      mission_evidence[name] = {claim_id=data.claim.id, sources={}}
    end
    core.log('action','NEMO_CLAIM_RESULT id='..data.claim.id..' task='..data.claim.task_id)
    message(name, 'Claimed '..data.claim.id)
  end)
  return true, 'Claiming.'
end})
local function evidence(name)
  if not mission_evidence[name] then mission_evidence[name] = {sources={}} end
  return mission_evidence[name]
end
core.register_chatcommand('nemo_source', {params='URL PAGE_OR_SECTION', description='Record a source you actually checked for your mission', func=function(name, args)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  local url, location = args:match('^(%S+)%s+(.+)$')
  if not url or not location or #location > 300 then return false, 'Use /nemo_source URL PAGE_OR_SECTION (300 characters max).' end
  local draft = evidence(name)
  if #draft.sources >= 10 then return false, 'At most ten sources are allowed. Use /nemo_evidence_reset to start again.' end
  draft.sources[#draft.sources+1] = {url=url, location=location}
  return true, 'Source '..#draft.sources..' recorded locally. Verify its exact location before submitting.'
end})
for _, field in ipairs({'method','limitations','rights'}) do
  core.register_chatcommand('nemo_'..field, {params='YOUR_TEXT', description='Record your own '..field..' for the mission submission', func=function(name, value)
    if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
    if not value or value == '' or #value > 2000 then return false, 'Give your '..field..' in 1–2000 characters.' end
    evidence(name)[field] = value
    return true, 'Your '..field..' statement is saved locally for this pairing.'
  end})
end
core.register_chatcommand('nemo_evidence_reset', {params='', description='Discard locally entered mission evidence', func=function(name)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  mission_evidence[name] = nil
  return true, 'Local evidence cleared. No server record was changed.'
end})
core.register_chatcommand('nemo_submit', {params='the deliverable text', description='Submit evidence for your active claim', func=function(name, artifact)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  if not artifact or artifact == '' then return false, 'Give the deliverable text.' end
  local draft = evidence(name)
  if not draft.method or not draft.limitations or not draft.rights or #draft.sources == 0 then
    return false, 'Before submitting, enter /nemo_source URL PAGE_OR_SECTION, /nemo_method TEXT, /nemo_limitations TEXT and /nemo_rights TEXT with statements you checked.'
  end
  -- The active claim is read from NemoWorld, never typed here: the native client cannot name a
  -- claim or a recipient that is not already its own.
  paired_request(name, '/native/missions', {player=name}, function(listed, board)
    if not listed then core.log('action','NEMO_SUBMIT_ERROR '..tostring(board)); message(name, board); return end
    local claim = board.active_claim
    if not claim and draft.last_claim_id and draft.last_artifact == artifact then
      -- A reply may have been lost after the server saved the first version. The bridge checks
      -- that this exact payload belongs to this avatar before returning the stored submission.
      claim = {id=draft.last_claim_id}
    end
    if not claim then core.log('action','NEMO_SUBMIT_ERROR no-active-claim'); message(name, 'Claim a task first.'); return end
    paired_request(name, '/native/submit', {player=name, claim_id=claim.id, artifact=artifact,
      method=draft.method, limitations=draft.limitations, rights=draft.rights,
      sources=draft.sources}, function(ok, data)
      if not ok then core.log('action','NEMO_SUBMIT_ERROR '..tostring(data)); message(name, data); return end
      draft.last_claim_id = claim.id
      draft.last_artifact = artifact
      core.log('action','NEMO_SUBMIT_RESULT id='..data.submission.id..' status='..data.submission.status)
      message(name, 'Submitted '..data.submission.id)
    end)
  end)
  return true, 'Submitting.'
end})

-- Conversation over the same private message records the browser uses. The paired human's own
-- credential selects the sender; a native client can only address a resident it can see, and the
-- token never enters the world, a log or a prompt.
core.register_chatcommand('nemo_chat', {params='', description='Read the recent messages you can see', func=function(name)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  paired_request(name, '/native/messages', {player=name}, function(ok, data)
    if not ok then core.log('action','NEMO_CHAT_ERROR '..tostring(data)); message(name, data); return end
    local ids, lines = {}, {}
    for _, item in ipairs(data.messages or {}) do
      ids[#ids+1] = item.id
      lines[#lines+1] = (item.channel == 'private' and '[private] ' or '') .. (item.author or '?') .. ': ' .. tostring(item.text)
    end
    core.log('action','NEMO_CHAT_RESULT ids='..table.concat(ids,','))
    message(name, #lines > 0 and table.concat(lines, ' | ') or 'No recent messages.')
  end)
  return true, 'Reading messages.'
end})
core.register_chatcommand('nemo_say', {params='text', description='Say a public message in your world', func=function(name, text)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  paired_request(name, '/native/say', {player=name, text=text}, function(ok, data)
    if not ok then core.log('action','NEMO_SAY_ERROR '..tostring(data)); message(name, data); return end
    core.log('action','NEMO_SAY_RESULT id='..data.message.id..' channel='..data.message.channel)
    message(name, 'Sent.')
  end)
  return true, 'Sending.'
end})
core.register_chatcommand('nemo_tell', {params='RESIDENT_ID then the message', description='Privately message a resident you can see', func=function(name, args)
  if not paired[name] then return false, 'Sign in with /nemo_connect first.' end
  local to, text = args:match('^(%S+)%s+(.+)$')
  if not to or not text then return false, 'Use /nemo_tell RESIDENT_ID then the message.' end
  paired_request(name, '/native/say', {player=name, to=to, text=text}, function(ok, data)
    if not ok then core.log('action','NEMO_TELL_ERROR '..tostring(data)); message(name, data); return end
    core.log('action','NEMO_TELL_RESULT id='..data.message.id..' channel='..data.message.channel)
    message(name, 'Sent privately.')
  end)
  return true, 'Sending.'
end})
core.register_globalstep(function(dt)
  motion_clock = motion_clock + dt
  sync_elapsed = sync_elapsed + dt
  if sync_elapsed >= 5 then
    sync_elapsed = 0
    for name,state in pairs(motion) do
      if paired[name] then sync(name)
      elseif state.retry_resume and not state.resume_pending then resume_player(name) end
    end
  end
  for _, player in ipairs(core.get_connected_players()) do
    local name = player:get_player_name()
    local state = motion[name]
    local p = player:get_pos()
    if p.x < 0 or p.x >= 48 or p.z < 0 or p.z >= 48 or p.y < -1 or p.y > 12 then
      local safe = state and state.anchor or {x=24,y=2,z=24}
      player:set_pos(safe)
      stop_player(player)
      p = player:get_pos()
    end
    if paired[name] and state and state.anchor then
      local dx, dz = p.x - state.anchor.x, p.z - state.anchor.z
      if state.in_flight then
        -- Keep client-side physics from carrying the player through a second tile while the
        -- bridge is confirming the first one. The authoritative response will release the gate.
        local offset={x=0,z=0}
        if state.last_direction=='right' then offset.x=math.min(0.95,math.max(0,dx))
        elseif state.last_direction=='left' then offset.x=math.max(-0.95,math.min(0,dx))
        elseif state.last_direction=='down' then offset.z=math.min(0.95,math.max(0,dz))
        elseif state.last_direction=='up' then offset.z=math.max(-0.95,math.min(0,dz)) end
        if math.abs(dx-offset.x)>0.05 or math.abs(dz-offset.z)>0.05 then
          player:set_pos({x=state.anchor.x+offset.x,y=p.y,z=state.anchor.z+offset.z})
          stop_horizontal(player)
        end
      elseif math.max(math.abs(dx), math.abs(dz)) >= motion_threshold then
        local direction
        if math.abs(dx) >= math.abs(dz) then direction = dx > 0 and 'right' or 'left'
        else direction = dz > 0 and 'down' or 'up' end
        stop_horizontal(player)
        request_move(name, direction)
      end
    end
  end
end)
