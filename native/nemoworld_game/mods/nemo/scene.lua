-- Render-only environment from authoritative terrain/gates. These nodes never create builds,
-- consume resources, block a saved move, become inventory or award a contribution.
local function decoration(name, texture, boxes, extra)
  local def={description='NemoWorld scenery',drawtype='nodebox',tiles={texture},
    node_box={type='fixed',fixed=boxes},walkable=false,pointable=false,diggable=false,
    groups={immortal=1},drop='',sunlight_propagates=true,paramtype='light'}
  for key,value in pairs(extra or {}) do def[key]=value end
  core.register_node('nemo:scenery_'..name,def)
end
decoration('trunk','nemo_cc0_wood.jpg',{-0.13,-0.5,-0.13,0.13,0.5,0.13})
decoration('leaves','nemo_cc0_grass.jpg^[colorize:#396346:110',{-0.49,-0.5,-0.49,0.49,0.5,0.49})
decoration('crown','nemo_cc0_grass.jpg^[colorize:#53844d:100',{-0.34,-0.5,-0.34,0.34,0.25,0.34})
decoration('water','nemo_terrain_water.png',{-0.5,-0.49,-0.5,0.5,-0.42,0.5},{use_texture_alpha='blend'})
decoration('post','nemo_cc0_wood.jpg',{-0.12,-0.5,-0.12,0.12,0.5,0.12})
decoration('lintel','nemo_cc0_wood.jpg',{-0.5,-0.15,-0.3,0.5,0.15,0.3})
core.register_entity('nemo:gate_label',{initial_properties={physical=false,pointable=false,
  static_save=false,visual='sprite',visual_size={x=0.01,y=0.01},textures={'nemo_glass.png'},glow=10}})

return function(data)
  local nodes={}
  local function add(x,y,z,kind)
    if x<0 or x>47 or z<0 or z>47 or y<0 or y>7 then return end
    local pos={x=x,y=y,z=z}
    nodes[x..':'..y..':'..z]={pos=pos,type='scenery_'..kind}
  end
  for _,tile in ipairs(data.terrain or {}) do
    if tile.type=='tree' then
      add(tile.x,0,tile.y,'trunk'); add(tile.x,1,tile.y,'trunk')
      add(tile.x,2,tile.y,'leaves'); add(tile.x,3,tile.y,'crown')
    elseif tile.type=='water' then add(tile.x,0,tile.y,'water') end
  end
  for _,gate in ipairs(data.gates or {}) do
    local horizontal=gate.direction=='up' or gate.direction=='down'
    for height=0,2 do
      add(gate.x+(horizontal and -1 or 0),height,gate.y+(horizontal and 0 or -1),'post')
      add(gate.x+(horizontal and 1 or 0),height,gate.y+(horizontal and 0 or 1),'post')
    end
    for across=-1,1 do add(gate.x+(horizontal and across or 0),3,gate.y+(horizontal and 0 or across),'lintel') end
  end
  return nodes
end
