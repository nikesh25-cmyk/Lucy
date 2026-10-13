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
local reconciled = false
local emerging = false
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
    local body = response.succeeded and core.parse_json(response.data) or nil
    if not response.succeeded or type(body) ~= 'table' then callback(false, 'Bridge unavailable.')
    elseif response.code < 200 or response.code >= 300 then callback(false, body.error or 'Action refused.')
    else callback(true, body) end
  end)
end
local function key(pos) return pos.x .. ':' .. pos.y .. ':' .. pos.z end
local function sync(name)
  if not paired[name] or busy[name] or emerging then return end
  busy[name] = true
  request('/native/state', {player=name}, function(ok, data)
    busy[name] = nil
    if not ok then paired[name] = nil; message(name, data); return end
    local function apply()
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
      if player and data.player then
        local p = data.player
        player:set_pos({x=p.x, y=math.max(2, p.z + 2), z=p.y})
      end
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
  player:set_pos({x=24,y=2,z=24})
  local inventory = player:get_inventory()
  for kind in pairs(names) do inventory:add_item('main', 'nemo:place_' .. kind) end
  message(name, 'Pair with /nemo_pair CODE. Move with /nemo_move up|down|left|right. Click with a block item to request placement; punch a block to request removal.')
end)
core.register_on_leaveplayer(function(player) paired[player:get_player_name()] = nil end)
core.register_chatcommand('nemo_pair', {params='CODE', description='Pair this player to an operator-owned human avatar', func=function(name, code)
  if not code:match('^[a-f0-9]+$') then return false, 'Invalid pairing code.' end
  request('/native/pair', {player=name, code=code}, function(ok, data)
    if ok then paired[name] = true; message(name, 'Paired to frontier:0:0.'); sync(name)
    else message(name, data) end
  end)
  return true, 'Pairing request sent.'
end})
core.register_chatcommand('nemo_move', {params='up|down|left|right', description='Request one authoritative step', func=function(name, direction)
  if not ({up=true,down=true,left=true,right=true})[direction] then return false, 'Choose up, down, left or right.' end
  if not paired[name] then return false, 'Pair first.' end
  request('/native/action', {player=name, action='move', direction=direction}, function(ok, data)
    if not ok then message(name, data) else sync(name) end
  end)
  return true, 'Step requested.'
end})
local elapsed = 0
core.register_globalstep(function(dt)
  elapsed = elapsed + dt
  if elapsed < 5 then return end
  elapsed = 0
  for name in pairs(paired) do sync(name) end
  for _, player in ipairs(core.get_connected_players()) do
    local p=player:get_pos()
    if p.x < 0 or p.x >= 48 or p.z < 0 or p.z >= 48 or p.y < -1 or p.y > 12 then player:set_pos({x=24,y=2,z=24}) end
  end
end)
