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

decoration('plot_edge','nemo_cc0_terracotta.jpg^[colorize:#eac36b:160',{{-0.5,-0.49,-0.5,0.5,-0.46,-0.46},{-0.5,-0.49,0.46,0.5,-0.46,0.5},{-0.5,-0.49,-0.5,-0.46,-0.46,0.5},{0.46,-0.49,-0.5,0.5,-0.46,0.5}})
decoration('building','nemo_cc0_terracotta.jpg',{-0.49,-0.5,-0.49,0.49,1.4,0.49})
decoration('roof','nemo_cc0_rock.jpg',{-0.5,-0.5,-0.5,0.5,-0.1,0.5})
decoration('bench','nemo_cc0_wood.jpg',{-0.45,-0.3,-0.3,0.45,0.15,0.3})
decoration('flowers','nemo_cc0_grass.jpg^[colorize:#dba878:110',{-0.22,-0.5,-0.22,0.22,0.1,0.22})
return function(data)
  local nodes={}
  local function add(x,y,z,kind)
    if x<0 or x>=(data.bounds and data.bounds.columns or 48) or z<0 or z>=(data.bounds and data.bounds.rows or 48) or y<0 or y>7 then return end
    local pos={x=x,y=y,z=z}
    nodes[x..':'..y..':'..z]={pos=pos,type='scenery_'..kind}
  end
  for _,tile in ipairs(data.terrain or {}) do
    if tile.type=='tree' then
      add(tile.x,0,tile.y,'trunk'); add(tile.x,1,tile.y,'trunk')
      add(tile.x,2,tile.y,'leaves'); add(tile.x,3,tile.y,'crown')
    elseif tile.type=='water' then add(tile.x,0,tile.y,'water')
    elseif tile.type=='building' or tile.type=='wall' then add(tile.x,0,tile.y,'building');add(tile.x,2,tile.y,'roof')
    elseif tile.type=='fountain' then add(tile.x,0,tile.y,'water') end
  end
  local plot=data.creative and data.creative.my_plot
  if plot and plot.world_id==data.world_id then
    for x=plot.x,plot.x+5 do for z=plot.y,plot.y+5 do
      if (x==plot.x or x==plot.x+5 or z==plot.y or z==plot.y+5) and not nodes[x..':0:'..z] then add(x,0,z,'plot_edge') end
    end end
  end
  for _,object in ipairs(data.objects or {}) do
    if object.type=='bench' or object.type=='table' then add(object.x,0,object.y,'bench')
    elseif object.type=='cottage' or object.type=='shelter' or object.type=='mountain' then add(object.x,0,object.y,'building');add(object.x,2,object.y,'roof')
    elseif object.type=='flowers' or object.type=='farm' then add(object.x,0,object.y,'flowers') end
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
