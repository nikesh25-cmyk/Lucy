-- Walking routes are plans only. Every step and doorway entry is saved/refused by NemoWorld.
return function(options)
  local choices={}
  local function show(name,reason)
    local scene=options.scene(name)
    if not scene then return options.connect(name) end
    local list,seen={},{}
    for _,gate in ipairs(scene.gates or {}) do
      list[#list+1]={kind='portal',world_id=gate.target_world_id,label=(gate.direction or '')..' · '..gate.target_world_id..(gate.exists and '' or ' · open new area')};seen[gate.target_world_id]=true
    end
    for _,portal in ipairs(scene.portals or {}) do
      if not seen[portal.target_world_id] then list[#list+1]={kind='portal',world_id=portal.target_world_id,label=portal.label or portal.name or portal.target_world_id};seen[portal.target_world_id]=true end
    end
    if scene.own_home then list[#list+1]={kind='home',world_id=scene.own_home.id,label='Your garden · '..scene.own_home.name} end
    choices[name]=list
    local labels={}
    for _,item in ipairs(list) do labels[#labels+1]=core.formspec_escape(item.label) end
    core.show_formspec(name,'nemo:travel','formspec_version[4]size[12,6]label[0.5,0.6;Explore · '..core.formspec_escape(scene.world_name or scene.world_id)..']'..
      'textarea[0.5,1.1;11,1.1;;;'..core.formspec_escape(reason or 'Choose an entrance. Your character walks there and enters using the shared world’s permissions. Press a movement key to cancel.')..']'..
      (#labels>0 and ('dropdown[0.5,2.7;11,0.8;destination;'..table.concat(labels,',')..';1;true]button_exit[0.5,3.9;7,0.9;go;Walk to entrance and enter]') or 'label[0.5,3;No doorway is available here.]')..
      'button_exit[8,3.9;3.5,0.9;close;Back]')
  end
  core.register_chatcommand('nemo_travel',{description='Explore entrances, connected regions and your home',func=function(name) show(name);return true,'Choose a place.' end})
  core.register_on_player_receive_fields(function(player,form,fields)
    if form~='nemo:travel' then return false end
    local name=player:get_player_name()
    if fields.go then
      local target=(choices[name] or {})[tonumber(fields.destination or '') or 0]
      if target then options.navigate(name,target) else show(name,'Choose a destination.') end
    end
    return true
  end)
  return{show=show,clear=function(name) choices[name]=nil end}
end
