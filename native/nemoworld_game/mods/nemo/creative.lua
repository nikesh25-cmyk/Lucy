-- A native interface to existing land/build APIs; no inventory, coin or mission authority here.
return function(options)
  local formname='nemo:creative'
  local drafts={}
  local function available_plots(scene)
    local plots={}
    for _,parcel in ipairs(scene.creative.parcels or {}) do
      if parcel.can_assign then plots[#plots+1]=parcel end
    end
    local function distance(plot)
      local dx=math.max(plot.x-scene.player.x,0,scene.player.x-(plot.x+5))
      local dz=math.max(plot.y-scene.player.y,0,scene.player.y-(plot.y+5))
      return dx+dz
    end
    table.sort(plots,function(a,b)
      local da,db=distance(a),distance(b)
      return da<db or (da==db and a.id<b.id)
    end)
    return plots
  end
  local function show(name,reason)
    local scene=options.scene(name)
    if not scene or not scene.creative then return options.connect(name,'Connect a human character and wait for the shared scene first.') end
    local data=scene.creative
    local parts={'formspec_version[4]size[13,11]label[0.5,0.5;Creative building]',
      'label[0.5,1;Free reusable tools. Saved construction obeys land and shared-world limits. No coins awarded.]'}
    for i,kind in ipairs(data.palette or {}) do
      local x=0.6+((i-1)%9)*1.4
      parts[#parts+1]='item_image_button['..x..',1.6;1.1,1.1;nemo:place_'..kind..';material_'..kind..';]'
      parts[#parts+1]='label['..x..',2.9;'..core.formspec_escape(kind)..']'
    end
    local plot=data.my_plot
    local local_plot=plot and plot.world_id==scene.world_id and plot or nil
    if plot then
      parts[#parts+1]='textarea[0.5,3.6;12,1;;;'..core.formspec_escape('Your plot: '..plot.id..' | '..(plot.purpose or '')..(local_plot and '' or ' | Travel to its sector before building.')..'\nYour AI residents can build here using their existing scoped runtime. Other operators need a collaboration grant.')..']'
    else
      local choices={}
      for _,parcel in ipairs(available_plots(scene)) do
        choices[#choices+1]=core.formspec_escape(parcel.id..' · '..parcel.x..','..parcel.y)
      end
      if #choices>0 then
        parts[#parts+1]='dropdown[0.5,3.6;5.8,0.8;plot;'..table.concat(choices,',')..';1;true]'
        parts[#parts+1]='field[6.5,3.6;6,0.8;purpose;Project name / purpose;Creative workshop]'
        parts[#parts+1]='button[0.5,4.6;4,0.8;claim;Use this free building plot]'
      else parts[#parts+1]='label[0.5,3.9;No free plot here. Use Travel and places to reach Shared Frontier.]' end
    end
    if local_plot then parts[#parts+1]='button_exit[0.5,4.7;5.4,0.8;walk_plot;Walk to my plot]' end
    parts[#parts+1]='button_exit[6.4,4.7;5.6,0.8;travel_places;Travel and places]'
    local blueprints={}
    for _,blueprint in ipairs(data.blueprints or {}) do blueprints[#blueprints+1]=core.formspec_escape(blueprint.name..' · '..blueprint.block_count..' blocks') end
    local draft=drafts[name] or {}
    local anchor=draft.pos or {x=local_plot and local_plot.x or scene.player.x,y=0,z=local_plot and local_plot.y or scene.player.y}
    if #blueprints>0 then
      parts[#parts+1]='label[0.5,5.8;Saved building blueprints · preview before placing]'
      parts[#parts+1]='dropdown[0.5,6.3;5.8,0.8;blueprint;'..table.concat(blueprints,',')..';'..(draft.index or 1)..';true]'
      parts[#parts+1]='field[6.5,6.3;2.5,0.8;anchor_x;Tile X;'..anchor.x..']field[9.5,6.3;2.5,0.8;anchor_z;Tile Y;'..anchor.z..']'
      parts[#parts+1]='button[0.5,7.4;4.8,0.8;preview;Preview footprint]button[6,7.4;6,0.8;build;Place previewed blueprint]'
    end
    parts[#parts+1]='textarea[0.5,8.6;12,1.3;;;'..core.formspec_escape(reason or 'Choose a material, then right-click nearby ground to place. Punch your saved blocks to remove. Open inventory for every material. Walk to your plot before building.')..']'
    parts[#parts+1]='button_exit[4.5,10;4,0.7;close;Return to world]'
    core.show_formspec(name,formname,table.concat(parts))
  end
  core.register_chatcommand('nemo_build',{description='Free creative tools, your plot and building blueprints',func=function(name) show(name);return true,'Creative tools opened.' end})
  core.register_on_player_receive_fields(function(player,form,fields)
    if form~=formname then return false end
    local name=player:get_player_name()
    local scene=options.scene(name)
    if not scene or not scene.creative then options.connect(name);return true end
    for _,kind in ipairs(scene.creative.palette or {}) do
      if fields['material_'..kind] then
        for index,stack in ipairs(player:get_inventory():get_list('main') or {}) do
          if stack:get_name()=='nemo:place_'..kind then
            player:set_wield_index(index);core.close_formspec(name,formname)
            options.message(name,kind..' selected. The tool is reusable; land and distance rules still apply.')
            return true
          end
        end
        show(name,'Tool not found. Rejoin to restore your creative palette.');return true
      end
    end
    if fields.walk_plot and options.navigate then options.navigate(name,{kind='plot'});return true end
    if fields.travel_places and options.travel then options.travel(name);return true end
    if fields.claim then
      local available=available_plots(scene)
      local selected=available[tonumber(fields.plot or '')]
      if not selected then show(name,'Choose an available plot.');return true end
      options.request(name,'/native/plot',{player=name,plot_id=selected.id,purpose=fields.purpose or ''},function(ok,data)
        if ok then
          scene.creative.my_plot=data.result.plot
          options.sync(name)
          if options.navigate then options.navigate(name,{kind='plot'}) else show(name,'Plot saved. Choose Walk to my plot to reach a usable building spot.') end
        else show(name,data) end
      end)
    elseif fields.preview or fields.build then
      local index=tonumber(fields.blueprint or '')
      local blueprint=scene.creative.blueprints[index or 0]
      local x,z=tonumber(fields.anchor_x or ''),tonumber(fields.anchor_z or '')
      if not blueprint or not x or not z or x~=math.floor(x) or z~=math.floor(z) then show(name,'Choose a blueprint and whole-number tile coordinates.');return true end
      local id=scene.world_id..':'..blueprint.id..':'..x..':'..z
      if fields.build and (not drafts[name] or drafts[name].id~=id or not drafts[name].valid) then show(name,'Preview this exact footprint successfully before placing it.');return true end
      local payload={player=name,action='blueprint',blueprint=blueprint.id,pos={x=x,y=0,z=z},preview=not fields.build}
      options.request(name,'/native/action',payload,function(ok,data)
        if not ok then drafts[name]=nil;show(name,data);return end
        if fields.preview then
          local report=data.result
          drafts[name]={id=id,index=index,pos=payload.pos,valid=report.valid==true}
          local reasons={}
          for _,issue in ipairs(report.issues or {}) do reasons[#reasons+1]=issue.message end
          show(name,report.valid and 'Valid footprint. No blocks saved yet. Choose Place previewed blueprint to apply.' or table.concat(reasons,'\n'))
        else
          drafts[name]=nil;options.sync(name);show(name,'Blueprint saved. Its accepted blocks are shared with the browser and AI residents. No coin awarded.')
        end
      end)
    end
    return true
  end)
  return {show=show,clear=function(name) drafts[name]=nil end}
end
