// Drop operator-visible state immediately when the browser's authenticated session ends.
// This does not delete saved world data, drafts, accounts or running server jobs.
export function clearOperatorState(state){
 state.sessionEpoch=(state.sessionEpoch||0)+1;
 Object.assign(state,{account:null,agents:[],selected:'',viewWorld:'',focus:null,building:false,tab:'world',world:{participants:[],messages:[],paused:false},worlds:[],worldTotal:0,directoryHasMore:false,missions:[],tasks:[],missionQuery:{},missionPage:{missions:[],tasks:[],total:0,offset:0,limit:12,has_more:false},gallery:[],history:{claims:[],submissions:[],reviews:[],drafts:[],jobs:[]},workers:{resident:null,research:null},safety:{reports:[],appeals:[]},operations:null,journey:null,briefModes:{},community:{circles:[],projects:[],events:[],thanks:[],counts:{},pagination:{}}});
 return state.sessionEpoch;
}
