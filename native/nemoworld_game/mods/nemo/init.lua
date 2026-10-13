-- Original NemoWorld Lua mod. All mutable world records belong to the Node service.
local http = core.request_http_api()
if not http then error('nemo requires secure.http_mods = nemo and a cURL-enabled Luanti server') end
local endpoint = core.settings:get('nemo_bridge_url') or 'http://127.0.0.1:3999'
local mod_key = core.settings:get('nemo_bridge_key')
if not mod_key or #mod_key < 32 then error('nemo_bridge_key must match the local bridge key') end
core.set_mapgen_setting('mg_name', 'singlenode', true)
local size = 48
local paired = {}
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
local names = {stone=true, wood=true, glass=true, brick=true, sand=true, grass=true, path=true}
local terrain_types = {meadow=true,tree=true,water=true,garden=true,path=true,plaza=true,grass=true}
local markers = {}

local function inside(pos)
  return pos and pos.x >= 0 and pos.x < size and pos.z >= 0 and pos.z < size and pos.y >= 0 and pos.y <= 7
    and pos.x == math.floor(pos.x) and pos.y == math.floor(pos.y) and pos.z == math.floor(pos.z)
end
local function message(name, text)
  if core.get_player_by_name(name) then core.chat_send_player(name, '[NemoWorld] ' .. text) end
end
local function request(path, payload, callback)
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
local function key(pos) return pos.x .. ':' .. pos.y .. ':' .. pos.z end
local sync
local function stop_player(player)
  if player and player.set_velocity then player:set_velocity({x=0, y=0, z=0}) end
end
local function set_anchor(name, player, pos, release)
  if not player or not pos then return end
  local target = {x=pos.x, y=math.max(2, pos.z + 2), z=pos.y}
  local current = player:get_pos()
  local state = motion[name] or {}
  local dx, dy, dz = current.x - target.x, current.y - target.y, current.z - target.z
  -- A sync is a reconciliation point, not a heartbeat teleport. Small differences are normal
  -- while Luanti settles a step and are left alone to avoid visible jitter.
  if release or not state.anchor or math.max(math.abs(dx), math.abs(dy), math.abs(dz)) > 0.45 then
    player:set_pos(target)
    stop_player(player)
  end
  state.anchor = {x=target.x, y=target.y, z=target.z}
  if release then
    state.in_flight = false
    state.last_direction = nil
  end
  motion[name] = state
end
local function request_move(name, direction)
  local state = motion[name] or {}
  local generation = state.generation
  if not paired[name] then return false, 'Pair first.' end
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
      if code == 401 then paired[name] = nil end
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
      local next_nodes = {}
      for _, block in ipairs(data.blocks or {}) do
        local pos = {x=block.x, y=block.z, z=block.y}
        if inside(pos) and names[block.type] then
          local id = key(pos); next_nodes[id] = {pos=pos, type=block.type}
          local current = core.get_node(pos).name
          if current ~= 'nemo:' .. block.type then core.set_node(pos, {name='nemo:' .. block.type}) end
        end
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
      elseif data.player and release_now and state then
        -- The server confirmed the step, but a player object may have vanished during sync (or
        -- the server-only smoke probe may use a synthetic name). Do not strand motion in flight.
        state.in_flight = false
        state.last_direction = nil
      end
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
  if not paired[name] then message(name, 'Use /nemo_pair CODE first.'); return end
  if pos and not inside(pos) then message(name, 'Outside the 48 by 48 sector or block layers 0 to 7.'); return end
  request('/native/action', {player=name, action=action, pos=pos, type=block_type}, function(ok, data)
    if not ok then message(name, data) else sync(name) end
  end)
end

core.register_node('nemo:ground', {description='NemoWorld ground', tiles={'nemo_ground.png'}, diggable=false, pointable=true,
  groups={immortal=1}, on_punch=function() end})
for type_name in pairs(terrain_types) do
  core.register_node('nemo:terrain_' .. type_name, {description='NemoWorld ' .. type_name .. ' terrain', tiles={'nemo_terrain_' .. type_name .. '.png'},
    diggable=false, groups={immortal=1}, on_punch=function() end})
end
core.register_entity('nemo:resident', {initial_properties={physical=false,pointable=false,static_save=false,
  visual='cube',visual_size={x=0.55,y=1.05},textures={'nemo_resident.png','nemo_resident.png','nemo_resident.png','nemo_resident.png','nemo_resident.png','nemo_resident.png'}}})
core.register_node('nemo:boundary', {description='Finite sector boundary', tiles={'nemo_boundary.png'}, diggable=false,
  groups={immortal=1}, on_punch=function() end})
for type_name in pairs(names) do
  local kind = type_name
  core.register_node('nemo:' .. kind, {description='NemoWorld ' .. kind, tiles={'nemo_' .. kind .. '.png'},
    diggable=false, groups={immortal=1}, on_punch=function(pos, node, puncher)
      if puncher and puncher:is_player() then act(puncher:get_player_name(), 'remove', pos) end
    end})
  core.register_craftitem('nemo:place_' .. kind, {description='Request ' .. kind .. ' block', inventory_image='nemo_' .. kind .. '.png',
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
core.register_on_joinplayer(function(player)
  local name = player:get_player_name()
  motion[name] = {anchor={x=24,y=2,z=24}, last_request=-math.huge}
  player:set_pos({x=24,y=2,z=24})
  local inventory = player:get_inventory()
  for kind in pairs(names) do inventory:add_item('main', 'nemo:place_' .. kind) end
  message(name, 'Pair with /nemo_pair CODE. Move with /nemo_move up|down|left|right. Click with a block item to request placement; punch a block to request removal.')
end)
core.register_on_leaveplayer(function(player)
  local name = player:get_player_name()
  paired[name] = nil
  busy[name] = nil
  motion[name] = nil
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
    if motion[name] ~= previous or not motion[name] or motion[name].pairing_attempt ~= pairing_attempt then return end
    if ok then
      local next_generation = ((previous and previous.generation) or 0) + 1
      motion[name] = {anchor={x=24,y=2,z=24}, last_request=-math.huge, generation=next_generation}
      paired[name] = true
      busy[name] = nil
      message(name, 'Paired to the opened frontier.'); sync(name)
    else message(name, data) end
  end)
  return true, 'Pairing request sent.'
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
  if not paired[name] then return false, 'Use /nemo_pair CODE first.' end
  request('/native/missions', {player=name}, function(ok, data)
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
  if not paired[name] then return false, 'Use /nemo_pair CODE first.' end
  if not task_id or task_id == '' then return false, 'Give a task id from /nemo_missions.' end
  request('/native/claim', {player=name, task_id=task_id}, function(ok, data)
    if not ok then core.log('action','NEMO_CLAIM_ERROR '..tostring(data)); message(name, data); return end
    core.log('action','NEMO_CLAIM_RESULT id='..data.claim.id..' task='..data.claim.task_id)
    message(name, 'Claimed '..data.claim.id)
  end)
  return true, 'Claiming.'
end})
core.register_chatcommand('nemo_submit', {params='the deliverable text', description='Submit evidence for your active claim', func=function(name, artifact)
  if not paired[name] then return false, 'Use /nemo_pair CODE first.' end
  if not artifact or artifact == '' then return false, 'Give the deliverable text.' end
  -- The active claim is read from NemoWorld, never typed here: the native client cannot name a
  -- claim or a recipient that is not already its own.
  request('/native/missions', {player=name}, function(listed, board)
    if not listed then core.log('action','NEMO_SUBMIT_ERROR '..tostring(board)); message(name, board); return end
    local claim = board.active_claim
    if not claim then core.log('action','NEMO_SUBMIT_ERROR no-active-claim'); message(name, 'Claim a task first.'); return end
    request('/native/submit', {player=name, claim_id=claim.id, artifact=artifact,
      method='Read the original source and recorded the exact supporting section.',
      limitations='A native smoke fixture; facts and rights require human verification.',
      rights='Permission and attribution were checked for this fixture.',
      sources={{url='https://example.org/a', location='Section 1'}}}, function(ok, data)
      if not ok then core.log('action','NEMO_SUBMIT_ERROR '..tostring(data)); message(name, data); return end
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
  if not paired[name] then return false, 'Use /nemo_pair CODE first.' end
  request('/native/messages', {player=name}, function(ok, data)
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
  if not paired[name] then return false, 'Use /nemo_pair CODE first.' end
  request('/native/say', {player=name, text=text}, function(ok, data)
    if not ok then core.log('action','NEMO_SAY_ERROR '..tostring(data)); message(name, data); return end
    core.log('action','NEMO_SAY_RESULT id='..data.message.id..' channel='..data.message.channel)
    message(name, 'Sent.')
  end)
  return true, 'Sending.'
end})
core.register_chatcommand('nemo_tell', {params='RESIDENT_ID then the message', description='Privately message a resident you can see', func=function(name, args)
  if not paired[name] then return false, 'Use /nemo_pair CODE first.' end
  local to, text = args:match('^(%S+)%s+(.+)$')
  if not to or not text then return false, 'Use /nemo_tell RESIDENT_ID then the message.' end
  request('/native/say', {player=name, to=to, text=text}, function(ok, data)
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
    for name in pairs(paired) do sync(name) end
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
        if math.max(math.abs(dx), math.abs(p.y - state.anchor.y), math.abs(dz)) > 0.2 then
          player:set_pos(state.anchor)
          stop_player(player)
        end
      elseif math.max(math.abs(dx), math.abs(dz)) >= motion_threshold then
        local direction
        if math.abs(dx) >= math.abs(dz) then direction = dx > 0 and 'right' or 'left'
        else direction = dz > 0 and 'down' or 'up' end
        player:set_pos(state.anchor)
        stop_player(player)
        request_move(name, direction)
      end
    end
  end
end)
