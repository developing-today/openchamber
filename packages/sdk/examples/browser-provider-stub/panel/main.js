(()=>{var D="openchamber.sdk",W=1;var cS=`
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [data-oc-scrolling] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [data-oc-scrolling] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [data-oc-scrolling]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [data-oc-scrolling] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;function dS(S){let _=S.documentElement;if(_.hasAttribute("data-oc-scrollbar-activity"))return;_.setAttribute("data-oc-scrollbar-activity","");let M=new WeakMap;S.addEventListener("scroll",(C)=>{let B=C.target===S?_:C.target;if(!(B instanceof Element))return;if(!B.hasAttribute("data-oc-scrolling"))B.setAttribute("data-oc-scrolling","");let F=M.get(B);if(F!==void 0)clearTimeout(F);M.set(B,setTimeout(()=>{M.delete(B),B.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var KT=`(${dS.toString()})(document);`;var vS=128,uS=65536;var $S=128;var YS=65536;var cG=/^[a-z][a-z0-9-]{0,39}$/;var gG=(S)=>Object(S)===S&&!Array.isArray(S),pS=(S,_)=>Object.keys(S).every((M)=>_.includes(M)),hG=(S)=>String(S)===S&&S.length>=1&&S.length<=60,mG=(S)=>String(S)===S&&S.length>=1&&S.length<=80,dG=(S)=>{if(!Array.isArray(S)||S.length>4)return!1;let _=new Set;for(let M of S){if(!gG(M)||!cG.test(M.id)||!hG(M.label))return!1;if(M.disabled!==void 0&&M.disabled!==!0&&M.disabled!==!1)return!1;if(_.has(M.id))return!1;if(_.add(M.id),M.kind==="button"){if(!pS(M,["kind","id","label","disabled"]))return!1;continue}if(M.kind!=="select"||!pS(M,["kind","id","label","value","options","disabled"]))return!1;if(!mG(M.value)||!Array.isArray(M.options)||M.options.length<1||M.options.length>16)return!1;let C=new Set;for(let B of M.options){if(!gG(B)||!pS(B,["value","label"])||!mG(B.value)||!hG(B.label)||C.has(B.value))return!1;C.add(B.value)}if(!C.has(M.value))return!1}return!0};var QS=20000000,ZS=256;var lS=(S)=>("bytes"in S)?S.bytes.byteLength:S.content.length,vG=(S,_)=>{if(S.path!==_.path||S.readOnly!==_.readOnly)return!1;if(S.encoding==="text"||_.encoding==="text")return S.encoding==="text"&&_.encoding==="text"&&S.content===_.content;if(S.bytes.byteLength!==_.bytes.byteLength)return!1;for(let M=0;M<S.bytes.byteLength;M+=1)if(S.bytes[M]!==_.bytes[M])return!1;return!0};var uG=/^[A-Za-z0-9_-]{1,80}$/;var pG=["left","right","top","bottom"];var lG=(S,_=0,M={remaining:16000})=>{if(--M.remaining<0||_>=32)return!1;if(S===null)return!0;let C=Array.isArray(S)?S:Object(S)===S?Object.values(S):[];for(let B of C)if(!lG(B,_+1,M))return!1;return!0},aS=(S)=>{if(S===null||S===!0||S===!1)return!0;if(Array.isArray(S))return Object.keys(S).every((_)=>/^(0|[1-9]\d*)$/.test(_)&&Number(_)<S.length)&&S.every(aS);if(Object(S)===S){let _=Object.getPrototypeOf(S);return(_===null||_===Object.prototype)&&Object.values(S).every(aS)}return String(S)===S||Number.isFinite(S)},oS=(S)=>{try{if(String(S.id)!==S.id||!uG.test(S.id)||!Number.isFinite(S.anchor.x)||Math.abs(S.anchor.x)>1e5||!Number.isFinite(S.anchor.y)||Math.abs(S.anchor.y)>1e5||!Number.isFinite(S.anchor.width)||!Number.isFinite(S.anchor.height)||S.anchor.width<=0||S.anchor.height<=0||S.anchor.width>1e5||S.anchor.height>1e5||!Number.isInteger(S.width)||S.width<160||S.width>640||!Number.isInteger(S.height)||S.height<48||S.height>480||S.side!==void 0&&!pG.includes(S.side)||S.focus!==void 0&&S.focus!==!0&&S.focus!==!1||!lG(S.data)||!aS(S.data))return!1;return JSON.stringify(S.data).length<=16000}catch{return!1}};var oG=["file","directory","other","missing"],iS=(S)=>Boolean(S&&"sessionId"in S),rS=(S)=>Boolean(S&&"sent"in S&&!("sessionId"in S));var nG=/^[0-9a-f]{7,64}$/i,sS=(S)=>nG.test(S),zS=500,VS=32000,iG=16000,rG=128,sG=200,tG=2000,eG=16000,ST=80,GT=200,TT=16000;var _T=2000;var tS=20000,JS=1024,jS=2000000;var RS=64000,fS=8000,eS=4000;var SG=960000;var MT=999,UT=1e4,XS=500,ET=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],AT=["stopped","starting","ready","failed"],IT=new Set(ET),XT=(S)=>IT.has(S),OT=(S)=>S&&XT(S)?S:"HOST_REJECTED",r=(S)=>{if(S===void 0)return!1;if(S===null||S===!0||S===!1)return!0;if(String(S)===S)return!0;if(Number(S)===S)return Number.isFinite(S);if(Array.isArray(S))return S.every(r);if(Object(S)===S)return Object.values(S).every(r);return!1},PT=(S)=>r(S)&&JSON.stringify(S).length<=TT,aG=(S)=>S?.trim().slice(0,GT)??"",s=(S)=>{let _=S.id.trim().slice(0,rG),M=S.title.trim().slice(0,sG),C=S.url.trim().slice(0,tG),B=S.text?.trim().slice(0,eG),F=S.author?.trim().slice(0,ST),I=S.kind==="pull"?"pull":"issue",Q={providerId:S.providerId.trim(),id:_,title:M||_,url:C,kind:I};if(B)Q.text=B;if(F)Q.author=F;if(I==="pull"){let L=aG(S.branches?.head),x=aG(S.branches?.base);if(L&&x)Q.branches={head:L,base:x}}if(PT(S.data))Q.data=S.data;return Q},GG=(S)=>{let _=s(S);if(S.projectId)_.projectId=S.projectId;if(S.navigation)_.navigation=S.navigation;if(S.worktree)_.worktree=S.worktree;return _},TG=(S)=>{let _={text:S.text.trim().slice(0,iG)};if(S.send)_.send=!0;return _},_G=(S)=>{if(S===null||!Number.isFinite(S))return null;return Math.min(MT,Math.max(0,Math.round(S)))},MG=(S)=>{if(!Number.isFinite(S))return 0;return Math.min(UT,Math.max(0,Math.ceil(S)))};var t=(S)=>S.length>0&&S.length<=JS&&!S.includes("\x00")&&!S.includes("\\");var KS=(S)=>{if(!S.startsWith("/")||S.includes("\x00")||S.includes("\\")||S.includes("://"))return!1;if(S.length>_T)return!1;return!S.split("/").some((M)=>M==="."||M==="..")},LT=new Set(AT),UG=(S)=>Boolean(S&&"status"in S&&LT.has(String(S.status))&&!("body"in S)),IS=(S)=>Boolean(S&&"status"in S&&"body"in S&&Number.isInteger(S.status)),EG=(S)=>Boolean(S&&"content"in S&&String(S.content)===S.content),AG=(S)=>Boolean(S&&"written"in S&&S.written===!0),XG=(S)=>Boolean(S&&"entries"in S&&Array.isArray(S.entries)),kT=new Set(oG),OG=(S)=>Boolean(S&&"kind"in S&&"size"in S&&kT.has(String(S.kind))&&Number.isFinite(S.size)),PG=(S)=>Boolean(S&&"text"in S&&String(S.text)===S.text&&!("status"in S)),HT=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),NT=(S)=>Object(S)===S?S:null,nS=(S)=>String(S)===S&&S.length>0,wT=(S)=>{if(!nS(S.id))return null;if(S.ok===!0){let _={channel:D,v:W,type:"result",id:S.id,ok:!0};if(Object(S.payload)===S.payload)_.payload=S.payload;return _}if(S.ok===!1&&nS(S.error))return{channel:D,v:W,type:"result",id:S.id,ok:!1,error:S.error,code:OT(nS(S.code)?S.code:void 0)};return null},CG=(S)=>{let _=NT(S);if(!_||_.channel!==D||_.v!==W)return null;if(_.type==="result")return wT(_);if(!HT.has(String(_.type))||Object(_.payload)!==_.payload)return null;return _};var CT=(S)=>("key"in S)&&("metaKey"in S)&&("ctrlKey"in S),xT=(S)=>(S.metaKey||S.ctrlKey)&&!S.altKey&&!S.shiftKey&&S.key.toLowerCase()==="s";class A extends Error{code;constructor(S,_){super(_);this.name="HostRequestError",this.code=S}}var BT=()=>Promise.reject(new A("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),LS=()=>Promise.reject(new A("BAD_PATH",`File path must be 1 to ${JS} characters without NUL or backslash.`)),kS=(S)=>{if(S===void 0)return;if(Object(S)!==S||Array.isArray(S)||S.scope!==void 0&&S.scope!=="instance"&&S.scope!=="device")throw new A("HOST_REJECTED",'Storage scope must be "instance" or "device".');return S.scope==="device"?"device":void 0},P=(S)=>{return S.value+=1,`oc-${S.value}`},BG=(S={})=>{let _=S.target??("window"in globalThis?window:null);if(!_)throw new A("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let M=S.acceptSource??((G)=>G===_.parent),C=S.requestTimeoutMs??tS,B=new Set,F=new Set,I=new Set,Q=new Set,L=new Set,x=new Set,v=new Set,OS=new Set,PS=new Set,a=new Set,qS=[],TS=null,_S=null,CS=new Set,BS=new Set,MS=null,US=null,yS=!1,o=new Map,n=new Map,i=new Map,h=!1,O={value:0},X=null,m=null,ES=!1,AS=!1,fG=null,KG=(G)=>{if(!G)return null;return{sessionId:G.id,phase:G.busy?"started":"completed"}},b=(G)=>{_.parent.postMessage(G,"*")},IG=()=>{if(h||_.parent===_||a.size===0||X?.features?.lateGenerateResults!==!0)return;b({channel:D,v:W,type:"generate-late-listen"})},V=(G,T)=>{for(let U of G)try{U(T)}catch(E){console.error(E)}},LG=(G)=>{if(!(G instanceof MessageEvent))return;if(!M(G.source))return;let T=CG(G.data);if(!T)return;if(T.type==="workspace"){let E=n.get(T.payload.subscriptionId);if(E)V([E],T.payload.snapshot);return}if(T.type==="shells"){let E=i.get(T.payload.subscriptionId);if(E)V([E],T.payload.snapshot);return}if(T.type==="ready"){if(X=T.payload,m=KG(T.payload.session),V(B,T.payload),V(F,T.payload.directory),V(I,T.payload.session),m)V(Q,m);V(L,T.payload.connection),V(x,T.payload.settings),V(v,T.payload.item),IG();return}if(T.type==="generate-late"){if(a.size===0)qS.push(T.payload);else V(a,T.payload);return}if(T.type==="directory"){if(X)X={...X,directory:T.payload.directory};V(F,T.payload.directory);return}if(T.type==="session"){if(X)X={...X,session:T.payload.session};if(!T.payload.session)m=null;else if(m?.sessionId!==T.payload.session.id)m=KG(T.payload.session);V(I,T.payload.session);return}if(T.type==="session-lifecycle"){m=T.payload,V(Q,T.payload);return}if(T.type==="connection"){if(X)X={...X,connection:T.payload.connection};V(L,T.payload.connection);return}if(T.type==="settings"){if(X)X={...X,settings:T.payload.settings};V(x,T.payload.settings);return}if(T.type==="item"){if(X)X={...X,item:T.payload.item};V(v,T.payload.item);return}if(T.type==="status-control-event"){V(OS,T.payload);return}if(T.type==="popover-closed"){V(PS,T.payload);return}if(T.type==="action"){let E=($)=>{if(!h)b({channel:D,v:W,type:"action-result",id:T.id,payload:$})},Y=_S;if(!Y){E({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>Y(T.payload)).then(()=>E({ok:!0}),($)=>{let K=($ instanceof Error?$.message:String($)).trim();E({ok:!1,error:(K||"Action failed.").slice(0,XS)})});return}if(T.type==="file-open"){let E=T.payload;if(US&&vG(US,E))return;US=E,V(CS,T.payload);return}if(T.type==="file-saved"){V(BS,T.payload.version);return}if(T.type==="file-snapshot"){let E=(K)=>{if(!h)b({channel:D,v:W,type:"file-snapshot-result",id:T.id,payload:K})},Y=(K)=>E({error:(K.trim()||"Could not read the edited file.").slice(0,XS)}),$=MS;if(!$){Y("This extension does not edit files.");return}Promise.resolve().then(()=>$(T.payload.purpose)).then((K)=>{if(lS(K)>QS){Y(`The file is over ${QS} ${"bytes"in K?"bytes":"characters"}.`);return}if(K.version.length>ZS){Y(`The snapshot version is over ${ZS} characters.`);return}E({snapshot:"bytes"in K?{bytes:K.bytes,version:K.version}:{content:K.content,version:K.version}})},(K)=>Y(K instanceof Error?K.message:String(K)));return}if(T.type==="resolve"){let E=($)=>{b({channel:D,v:W,type:"resolve-result",id:T.id,payload:$})},Y=TS;if(!Y){E({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>Y(T.payload)).then(($)=>E({item:$?s($):null}),($)=>{let K=($ instanceof Error?$.message:String($)).trim();E({error:(K||"Command failed.").slice(0,XS)})});return}let U=o.get(T.id);if(!U)return;if(clearTimeout(U.timer),o.delete(T.id),T.ok){U.resolve(T.payload);return}U.reject(new A(T.code,T.error))};_.addEventListener("message",LG),b({channel:D,v:W,type:"hello"});let N=(G,T=C)=>{if(h||_.parent===_)return Promise.reject(new A("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((U,E)=>{let Y=setTimeout(()=>{o.delete(G.id),E(new A("HOST_TIMEOUT","Host did not answer in time."))},T);o.set(G.id,{resolve:U,reject:E,timer:Y}),b(G)})},R=(G)=>N(G).then(()=>{return}),f={channel:D,v:W},gS=(G)=>{if(!h&&_.parent!==_)b(G)},kG=()=>gS({...f,type:"file-save"}),HG=(G)=>{if(!CT(G)||!xT(G))return;G.preventDefault(),kG()},NG=(G)=>{if(!CT(G)||G.key!=="Escape"||X?.surface!=="popover"||!X.popover)return;G.preventDefault(),qG(X.popover.id,"escape").catch(()=>{return})},DS=()=>{let G=X?.surface==="popover"?X.popover:void 0;if(!G)return;let T=ES||AS;if(fG===T)return;fG=T,yG(G.id,T).catch(()=>{return})},WS=()=>{if(X?.surface!=="popover"||ES)return;ES=!0,DS()},wG=(G)=>{if(X?.surface!=="popover"||G.relatedTarget!==null||!ES)return;ES=!1,DS()},xG=()=>{if(X?.surface!=="popover"||AS)return;AS=!0,DS()},bG=()=>{if(X?.surface!=="popover"||!AS)return;AS=!1,DS()},g=(G,T=1024)=>{if(!G.trim()||G.length>T)throw new A("HOST_REJECTED",`Identity must contain 1 to ${T} characters.`)},hS=async(G)=>{if(G.kind!=="projects")g(G.projectId);let T=await N({...f,type:"workspace-read",id:P(O),payload:G});if(!T||!("kind"in T)||!("state"in T)||T.kind!==G.kind)throw new A("HOST_REJECTED","Host did not return workspace data.");return T},mS=async(G,T)=>{if(G.kind!=="projects")g(G.projectId);let U=P(O);n.set(U,T);try{await R({...f,type:"workspace-subscribe",id:P(O),payload:{subscriptionId:U,query:G}})}catch(E){if(n.delete(U),!h)b({...f,type:"workspace-unsubscribe",id:P(O),payload:{subscriptionId:U}});throw E}return()=>{if(!n.delete(U)||h)return;b({...f,type:"workspace-unsubscribe",id:P(O),payload:{subscriptionId:U}})}},fT=async(G,T)=>{if(G.kind==="session")g(G.sessionId);if(G.kind==="project")g(G.projectId);let U=P(O);i.set(U,T);try{await R({...f,type:"shells-subscribe",id:P(O),payload:{subscriptionId:U,scope:G}})}catch(E){if(i.delete(U),!h)b({...f,type:"shells-unsubscribe",id:P(O),payload:{subscriptionId:U}});throw E}return()=>{if(!i.delete(U)||h)return;b({...f,type:"shells-unsubscribe",id:P(O),payload:{subscriptionId:U}})}},FS=async(G)=>{if("key"in G&&(G.key.length===0||G.key.length>vS))throw new A("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(G.op==="set"&&!r(G.value))throw new A("HOST_REJECTED","Storage values must be JSON.");if(G.op==="set"&&new TextEncoder().encode(JSON.stringify(G.value)).length>uS)throw new A("HOST_REJECTED","Storage value exceeds 64 KiB.");if(G.scope==="device"&&X?.features?.deviceStorage!==!0)throw new A("UNSUPPORTED","This host does not support device storage.");let T=await N({...f,type:"storage",id:P(O),payload:G});if(!T||!("storage"in T)||T.op!==G.op)throw new A("HOST_REJECTED","Host did not return storage data.");return T},qG=(G,T)=>X?.features?.popovers!==!0&&!(X?.surface==="popover"&&X.popover?.id===G)?Promise.reject(new A("UNSUPPORTED","This host does not support popovers.")):R({...f,type:"popover-close",id:P(O),payload:T?{id:G,reason:T}:{id:G}}),yG=(G,T)=>X?.features?.popovers!==!0&&!(X?.surface==="popover"&&X.popover?.id===G)?Promise.reject(new A("UNSUPPORTED","This host does not support popovers.")):R({...f,type:"popover-anchor",id:P(O),payload:{id:G,active:T}});return _.addEventListener("keydown",NG,!0),_.addEventListener("pointerover",WS),_.addEventListener("pointermove",WS),_.addEventListener("pointerout",wG),_.addEventListener("focus",xG),_.addEventListener("blur",bG),{onAction:(G)=>{return _S=G,()=>{if(_S===G)_S=null}},listProjects:async()=>{let G=await hS({kind:"projects"});if(G.kind!=="projects")throw new A("HOST_REJECTED","Expected projects.");return G},listWorktrees:async(G)=>{let T=await hS({kind:"worktrees",projectId:G});if(T.kind!=="worktrees")throw new A("HOST_REJECTED","Expected worktrees.");return T},listSessions:async(G)=>{let T=await hS({kind:"sessions",projectId:G});if(T.kind!=="sessions")throw new A("HOST_REJECTED","Expected sessions.");return T},onProjects:(G)=>mS({kind:"projects"},(T)=>{if(T.kind==="projects")G(T)}),onWorktrees:(G,T)=>mS({kind:"worktrees",projectId:G},(U)=>{if(U.kind==="worktrees")T(U)}),onSessions:(G,T)=>mS({kind:"sessions",projectId:G},(U)=>{if(U.kind==="sessions")T(U)}),onRunningShells:(G,T)=>fT(G,T),readShellOutput:async(G,T)=>{g(G,$S);let U=T?.cursor;if(U!==void 0&&(!Number.isInteger(U)||U<0))throw new A("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let E=T?.tailBytes;if(E!==void 0&&(!Number.isInteger(E)||E<1||E>YS))throw new A("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${YS}.`);let $=await N({...f,type:"shell-output",id:P(O),payload:{shellId:G,cursor:U,tailBytes:E}});if(!$||typeof $.output!=="string"||!Number.isFinite($.cursor))throw new A("HOST_REJECTED","Host did not return shell output.");return $},stopShell:async(G)=>{if(g(G,$S),(await N({...f,type:"shell-stop",id:P(O),payload:{shellId:G}}))?.stopped!==!0)throw new A("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(G)=>{g(G),await R({...f,type:"open-session",id:P(O),payload:{sessionId:G}})},storage:{get:async(G,T)=>{let U=kS(T),E={op:"get",key:G};if(U)E.scope=U;let Y=await FS(E);return Y.op==="get"&&Y.found?Y.value:void 0},set:async(G,T,U)=>{let E=kS(U),Y={op:"set",key:G,value:T};if(E)Y.scope=E;await FS(Y)},delete:async(G,T)=>{let U=kS(T),E={op:"delete",key:G};if(U)E.scope=U;await FS(E)},keys:async(G)=>{let T=kS(G),U={op:"keys"};if(T)U.scope=T;let E=await FS(U);if(E.op!=="keys")throw new A("HOST_REJECTED","Expected storage keys.");return E.keys}},onReady:(G)=>{if(B.add(G),X)G(X);return()=>{B.delete(G)}},onDirectory:(G)=>{if(F.add(G),X)G(X.directory);return()=>{F.delete(G)}},onSession:(G)=>{if(I.add(G),X)G(X.session);return()=>{I.delete(G)}},onSessionLifecycle:(G)=>{if(Q.add(G),m)G(m);return()=>{Q.delete(G)}},onConnection:(G)=>{if(L.add(G),X)G(X.connection);return()=>{L.delete(G)}},onSettings:(G)=>{if(x.add(G),X)G(X.settings);return()=>{x.delete(G)}},onItem:(G)=>{if(v.add(G),X)G(X.item);return()=>{v.delete(G)}},onStatusControl:(G)=>{return OS.add(G),()=>{OS.delete(G)}},onPopoverClosed:(G)=>{return PS.add(G),()=>{PS.delete(G)}},setStatusControls:(G)=>{if(X?.features?.statusControls!==!0)return Promise.reject(new A("UNSUPPORTED","This host does not support status controls."));if(!dG(G))return Promise.reject(new A("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return R({...f,type:"status-controls",id:P(O),payload:{controls:G}})},openPopover:(G)=>{if(X?.features?.popovers!==!0)return Promise.reject(new A("UNSUPPORTED","This host does not support popovers."));if(!oS(G))return Promise.reject(new A("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return R({...f,type:"popover-open",id:P(O),payload:G})},closePopover:qG,setPopoverAnchorActive:yG,onResolve:(G)=>{return TS=G,()=>{if(TS===G)TS=null}},toast:(G)=>{let T=G.message.trim();if(!T||T.length>zS)return Promise.reject(new A("HOST_REJECTED",`Toast message must contain 1 to ${zS} characters.`));if(G.copy&&G.copy!==!0&&(!G.copy.text.length||G.copy.text.length>VS))return Promise.reject(new A("HOST_REJECTED",`Toast copy text must contain 1 to ${VS} characters.`));return R({channel:D,v:W,type:"toast",id:P(O),payload:{...G,message:T}})},openUrl:(G)=>R({channel:D,v:W,type:"open-url",id:P(O),payload:{url:G}}),openCommit:(G)=>sS(G)?R({channel:D,v:W,type:"open-commit",id:P(O),payload:{sha:G}}):Promise.reject(new A("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(G)=>R({channel:D,v:W,type:"open-surface",id:P(O),payload:{surfaceId:G}}),writeClipboard:(G)=>R({channel:D,v:W,type:"clipboard-write",id:P(O),payload:{text:G}}),compose:(G)=>R({channel:D,v:W,type:"compose",id:P(O),payload:G}),attach:(G)=>R({channel:D,v:W,type:"attach",id:P(O),payload:s(G)}),startSession:async(G)=>{if(G.projectId!==void 0)g(G.projectId);let T=G.worktree;if(T&&T!==!0)if(T.kind==="existing")g(T.directory);else{if(T.name!==void 0)g(T.name,200);if(T.baseBranch!==void 0)g(T.baseBranch,200)}let U=await N({channel:D,v:W,type:"start-session",id:P(O),payload:GG(G)},S.requestTimeoutMs??180000);if(!iS(U))throw new A("HOST_REJECTED","Host did not return a session.");return U},prompt:(G)=>N({channel:D,v:W,type:"prompt",id:P(O),payload:TG(G)}).then((T)=>{if(!rS(T))throw new A("HOST_REJECTED","Host did not return a prompt result.");return T}),sessionLink:(G)=>R({channel:D,v:W,type:"session-link",id:P(O),payload:s(G)}),close:()=>R({channel:D,v:W,type:"close",id:P(O)}),oauthStart:()=>R({channel:D,v:W,type:"oauth-start",id:P(O)}),oauthDisconnect:()=>R({channel:D,v:W,type:"oauth-disconnect",id:P(O)}),request:(G)=>(KS(G.path)?N({channel:D,v:W,type:"request",id:P(O),payload:G}):BT()).then((T)=>{if(!IS(T))throw new A("HOST_REJECTED","Host request result was empty.");return T}),serviceRequest:(G)=>(KS(G.path)?N({channel:D,v:W,type:"service-request",id:P(O),payload:G}):BT()).then((T)=>{if(!IS(T))throw new A("HOST_REJECTED","Host service request result was empty.");return T}),serviceStatus:()=>N({channel:D,v:W,type:"service-status",id:P(O)}).then((G)=>{if(!UG(G))throw new A("HOST_REJECTED","Host did not return service status.");return G}),readFile:(G)=>(t(G)?N({channel:D,v:W,type:"file-read",id:P(O),payload:{path:G}}):LS()).then((T)=>{if(!EG(T))throw new A("HOST_REJECTED","Host did not return file content.");return T}),writeFile:(G,T)=>{if(!t(G))return LS();if(T.length>jS)return Promise.reject(new A("FILE_TOO_LARGE",`Content is over ${jS} characters.`));return N({channel:D,v:W,type:"file-write",id:P(O),payload:{path:G,content:T}}).then((U)=>{if(!AG(U))throw new A("HOST_REJECTED","Host did not confirm the write.");return U})},listDir:(G)=>(t(G)?N({channel:D,v:W,type:"file-list",id:P(O),payload:{path:G}}):LS()).then((T)=>{if(!XG(T))throw new A("HOST_REJECTED","Host did not return directory entries.");return T}),stat:(G)=>(t(G)?N({channel:D,v:W,type:"file-stat",id:P(O),payload:{path:G}}):LS()).then((T)=>{if(!OG(T))throw new A("HOST_REJECTED","Host did not return file status.");return T}),generate:(G)=>{let T=G.prompt.trim(),U=G.system?.trim();if(T.length===0||T.length>RS)return Promise.reject(new A("HOST_REJECTED",`Prompt must be 1 to ${RS} characters.`));if(U!==void 0&&(U.length===0||U.length>fS))return Promise.reject(new A("HOST_REJECTED",`System prompt must be 1 to ${fS} characters.`));let E=G.maxOutputTokens===void 0?void 0:Math.min(eS,Math.max(1,Math.floor(G.maxOutputTokens)));if(E!==void 0&&!Number.isFinite(E))return Promise.reject(new A("HOST_REJECTED","maxOutputTokens must be a number."));let Y={prompt:T};if(U!==void 0)Y.system=U;if(E!==void 0)Y.maxOutputTokens=E;return N({channel:D,v:W,type:"generate",id:P(O),payload:Y},S.requestTimeoutMs??SG).then(($)=>{if(!PG($))throw new A("HOST_REJECTED","Host did not return generated text.");return $})},onLateGenerateResult:(G)=>{a.add(G);for(let T of qS.splice(0))V([G],T);return IG(),()=>{a.delete(G)}},setBadge:(G)=>R({channel:D,v:W,type:"badge",id:P(O),payload:{count:_G(G)}}),setHeight:(G)=>R({channel:D,v:W,type:"resize",id:P(O),payload:{height:MG(G)}}),onFileOpen:(G)=>{if(CS.add(G),!yS)yS=!0,_.addEventListener("keydown",HG,!0);if(US)G(US);return()=>{CS.delete(G)}},onFileSnapshot:(G)=>{return MS=G,()=>{if(MS===G)MS=null}},onFileSaved:(G)=>{return BS.add(G),()=>{BS.delete(G)}},reportFileChange:(G)=>gS({...f,type:"file-change",payload:{dirty:G.dirty,edited:G.edited}}),requestFileSave:kG,reportFileUnsupported:()=>gS({...f,type:"file-unsupported"}),dispose:()=>{for(let G of n.keys())b({...f,type:"workspace-unsubscribe",id:P(O),payload:{subscriptionId:G}});n.clear();for(let G of i.keys())b({...f,type:"shells-unsubscribe",id:P(O),payload:{subscriptionId:G}});if(i.clear(),h=!0,TS=null,_S=null,MS=null,CS.clear(),BS.clear(),yS)_.removeEventListener("keydown",HG,!0);_.removeEventListener("message",LG),_.removeEventListener("keydown",NG,!0),_.removeEventListener("pointerover",WS),_.removeEventListener("pointermove",WS),_.removeEventListener("pointerout",wG),_.removeEventListener("focus",xG),_.removeEventListener("blur",bG);for(let G of o.values())clearTimeout(G.timer),G.reject(new A("HOST_UNAVAILABLE","Host client was disposed."));o.clear(),B.clear(),F.clear(),I.clear(),Q.clear(),L.clear(),x.clear(),v.clear(),OS.clear(),PS.clear(),a.clear(),qS.length=0}}};var DT=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var B_=new Set(DT);var WT=["none","agent","user"];var W_=new Set(WT);var bT=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],qT=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],FT=(S,_)=>{_.style.colorScheme=S.mode;for(let[M,C]of bT)_.style.setProperty(M,S.tokens[C]);for(let[M,C,B]of qT){let F=S.tokens[B]??"";_.style.setProperty(M,F),_.style.setProperty(C,F)}_.style.setProperty("font-family",S.tokens.font),_.style.setProperty("font-size","0.875rem"),_.style.setProperty("line-height","1.45"),_.style.setProperty("color",S.tokens.foreground)},DG=(S,_)=>{if(FT(S.theme,_),_.dataset)_.dataset.ocSurface=S.surface,_.dataset.ocTheme=S.theme.mode};var yT={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},z=(S,_)=>`var(--${S}, var(--oc-${yT[S]}, ${_}))`,d=z("surface-background","transparent"),NS=z("surface-elevated","transparent"),e=z("surface-elevated-foreground","inherit"),y=z("surface-foreground","inherit"),Z=z("surface-muted-foreground","gray"),gT=z("surface-muted","transparent"),u=z("interactive-border","currentColor"),w=z("interactive-hover","transparent"),l=z("interactive-active","transparent"),WG=z("interactive-selection","transparent"),FG=z("interactive-selection-foreground","inherit"),c=z("primary","currentColor"),$G=z("primary-text","inherit"),YG=z("error-text","inherit"),hT=z("font-sans","inherit"),QG=z("font-mono","monospace"),zT=z("radius","9px"),ZG=`calc(${zT} - 2px)`,$T=`calc(${zT} - 4px)`,J=(S,_,M="transparent")=>`color-mix(in srgb, ${S} ${_}%, ${M})`,YT=`background-image: linear-gradient(${w}, ${w});`,zG=(S)=>`box-shadow: inset 0 0 0 1px ${S}, var(--oc-sdk-field-lift);`,VG="box-shadow: inset 0 0 0 1px var(--oc-sdk-edge), var(--oc-sdk-raised-lift);",QT="box-shadow: var(--oc-sdk-lit);",ZT=`inset 0 1px 0 0 ${J(y,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2)`,mT=`
:root {
  --oc-sdk-edge: ${J(y,10)};
  --oc-sdk-field-bg: ${NS};
  --oc-sdk-raised-bg: ${d};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 2px 0 rgb(0 0 0 / 0.06);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.45), 0 1px 2px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.8), inset 0 0 0 1px rgb(0 0 0 / 0.04), 0 0 0 1px rgb(0 0 0 / 0.1), 0 1px 2px -0.5px rgb(0 0 0 / 0.08), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.08);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${J(y,6)};
  --oc-sdk-field-bg: ${J(d,50,NS)};
  --oc-sdk-raised-bg: ${NS};
  --oc-sdk-field-lift: ${ZT};
  --oc-sdk-raised-lift: ${ZT};
  --oc-sdk-lit: inset 0 1px 0 0 ${J(y,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.36), 0 1px 1px -0.5px rgb(0 0 0 / 0.22), 0 3px 3px -1.5px rgb(0 0 0 / 0.2), 0 6px 6px -3px rgb(0 0 0 / 0.16);
}`,HS=(S)=>{let _=z(`status-${S}`,"currentColor");return`
.oc-sdk[data-tone="${S}"], .oc-sdk [data-tone="${S}"] { --oc-sdk-tone: ${_}; --oc-sdk-tone-text: ${z(`${S}-text`,"inherit")}; }`},cT=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: 6px; height: 28px; padding: 0 10px; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: 4px; height: 24px; padding: 0 8px; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: 14px; height: 14px; }

.oc-sdk-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: 8px 10px; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: 34px; padding-right: 34px; }
.oc-sdk-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 24px; height: 24px; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 2px; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(320px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: 2px 2px 4px; }
.oc-sdk-popup-search .oc-sdk-input { height: 28px; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: 14px; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: 8px; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: 36px; height: 20px; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: 2px; padding: 2px; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: 1px 6px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: 16px 8px; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: 12px; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: 16px; height: 16px; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: 12px; height: 12px; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: 8px; width: 100%; margin: 8px 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: 4px 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: 6px; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,VT=`${mT}
.oc-sdk { color: ${y}; font-family: ${hT}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${YT} }
.oc-sdk-mono { font-family: ${QG}; }
.oc-sdk-muted { color: ${Z}; }
${HS("success")}${HS("warning")}${HS("error")}${HS("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${c}; --oc-sdk-tone-text: ${$G}; }

.oc-sdk-btn { border-radius: ${ZG}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${$T}; }
.oc-sdk-btn[data-variant="default"] { color: ${$G}; background: ${J(c,10,d)}; border-color: ${J(c,12)}; ${QT} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${J(c,16,d)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${J(c,22,d)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${gT}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${l}, ${l}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${e}; border-color: transparent; ${VG} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${l}, ${l}); box-shadow: inset 0 0 0 1px var(--oc-sdk-edge); }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${w}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${l}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${z("status-error","red")}; color: ${YG}; background: ${J("var(--oc-sdk-tone)",7,d)}; border-color: ${J("var(--oc-sdk-tone)",12)}; ${QT} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${J("var(--oc-sdk-tone)",9,d)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${J("var(--oc-sdk-tone)",11,d)}; box-shadow: none; }

.oc-sdk-field-note { color: ${Z}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${YG}; }
.oc-sdk-input { border-radius: ${ZG}; background: var(--oc-sdk-field-bg); color: ${e}; ${zG("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${Z}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${zG(J(y,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${zG(z("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${QG}; }

.oc-sdk-search-icon { color: ${Z}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${c}; }
.oc-sdk-search-clear { border-radius: ${$T}; color: ${Z}; }
.oc-sdk-search-clear:hover { background: ${w}; color: ${y}; }

.oc-sdk-trigger { border-color: transparent; border-radius: ${ZG}; background: var(--oc-sdk-raised-bg); color: ${e}; ${VG} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${l}, ${l}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${Z}; }
.oc-sdk-trigger-chevron { color: ${Z}; }
/* The app's dropdown light: lit top, hairline rings and a layered shadow, no border. */
.oc-sdk-popup { --surface-foreground: ${e}; border-color: transparent; border-radius: 12px; background: ${NS}; color: ${e}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${w}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${WG}; color: ${FG}; }
.oc-sdk-option-check { color: ${y}; }
.oc-sdk-option[data-destructive="true"] { color: ${YG}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${J(z("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${Z}; }
.oc-sdk-popup-empty { color: ${Z}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${u}; border-radius: 4px; color: ${y}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${J(y,60,u)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${u}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${d}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${c}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${YT} }
.oc-sdk-check-desc { color: ${Z}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${J(y,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${Z}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${y}; }
.oc-sdk-tab[aria-selected="true"] { color: ${FG}; background: ${WG}; border-color: ${u}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${e}; background: var(--oc-sdk-raised-bg); border-color: transparent; ${VG} }
.oc-sdk-tab-count { color: ${Z}; }

.oc-sdk-badge { border-radius: 9999px; background: ${w}; color: ${Z}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${J("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${w}; }
.oc-sdk-row[aria-selected="true"] { background: ${WG}; color: ${FG}; }
.oc-sdk-row-lead { font-family: ${QG}; color: ${Z}; }
.oc-sdk-row-sub { color: ${Z}; }
.oc-sdk-row-meta { color: ${Z}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${Z}; }

.oc-sdk-empty-body { color: ${Z}; }

.oc-sdk-spinner { color: ${Z}; }
.oc-sdk-spinner-ring { border-color: ${u}; border-top-color: ${c}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${J("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${Z}; }

.oc-sdk-separator { color: ${Z}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${J(u,40)}; }

.oc-sdk-progress-label { color: ${Z}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${u}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${c}); }

.oc-sdk-text a { color: ${$G}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${J(u,60)}; }
`,k=`
${cS}
${cT}
${VT}`;var JT="oc-sdk-ui-style";var H=(S)=>{let _=document.getElementById(JT);if(_ instanceof HTMLStyleElement){if(_.textContent!==S)_.textContent=S;return}dS(document);let M=document.createElement("style");M.id=JT,M.textContent=S,document.head.appendChild(M)},j=(S,_)=>{let M=document.createElement(S);if(_)M.className=_;return M},p=(S)=>{let _=j("button",S);return _.type="button",_},q=(S,_)=>{let M=_??"";if(S.textContent!==M)S.textContent=M},SS=(S,_,M)=>{if(M===void 0||M===null||M==="")S.removeAttribute(_);else if(S.getAttribute(_)!==M)S.setAttribute(_,M)};var dT=()=>{let S=document.createElement("span");return S.className="oc-sdk-spinner-ring",S.setAttribute("aria-hidden","true"),S},GS=(S,_)=>{H(k);let M=_,C=p("oc-sdk oc-sdk-btn"),B=dT(),F=document.createElement("span");C.append(F),S.append(C);let I=()=>{if(C.dataset.variant=M.variant??"default",C.dataset.size=M.size??"default",C.disabled=Boolean(M.disabled)||Boolean(M.loading),C.dataset.loading=M.loading?"true":"false",C.setAttribute("aria-busy",M.loading?"true":"false"),M.loading&&B.parentNode!==C)C.prepend(B);else if(!M.loading&&B.parentNode===C)B.remove();q(F,M.label)},Q=()=>{if(M.disabled||M.loading)return;M.onClick()};return C.addEventListener("click",Q),I(),{update:(L)=>{M={...M,...L},I()},dispose:()=>{C.removeEventListener("click",Q),C.remove()}}};var JG=(S,_)=>{H(k);let M=_,C=j("label","oc-sdk oc-sdk-field"),B=j("span","oc-sdk-field-label"),F=M.multiline?j("textarea","oc-sdk-input"):j("input","oc-sdk-input"),I=j("span","oc-sdk-field-note");C.append(B,F,I),S.append(C);let Q=()=>{if(q(B,M.label),B.hidden=!M.label,F instanceof HTMLInputElement)F.type=M.password?"password":"text";else F.rows=M.rows??3;if(F.value!==M.value)F.value=M.value;F.disabled=Boolean(M.disabled),SS(F,"placeholder",M.placeholder),F.dataset.mono=M.mono?"true":"false";let x=Boolean(M.error);C.dataset.invalid=x?"true":"false",F.setAttribute("aria-invalid",x?"true":"false");let v=M.error??M.helper??"";q(I,v),I.hidden=v===""},L=()=>{M.onChange(F.value)};return F.addEventListener("input",L),Q(),{update:(x)=>{M={...M,...x},Q()},dispose:()=>{F.removeEventListener("input",L),C.remove()}}};var RG=BG(),RT=document.querySelector("#root");if(!RT)throw Error("Missing root");var jT=!1;RG.onReady((S)=>{if(DG(S,document.documentElement),jT)return;jT=!0;let _=document.createElement("div");_.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",RT.append(_);let M="",C=document.createElement("div");C.style.flex="1",_.append(C);let B=JG(C,{value:M,placeholder:"https://example.com",mono:!0,onChange:(Q)=>{M=Q,B.update({value:Q})}}),F=GS(_,{label:"Go",size:"sm",onClick:()=>{if(!M.trim())return;F.update({loading:!0}),RG.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:M.trim()})}).then(()=>I()).finally(()=>F.update({loading:!1}))}}),I=async()=>{try{let Q=await RG.serviceRequest({method:"GET",path:"/state"}),L=JSON.parse(Q.body);if(String(L.url)===L.url&&L.url!==M)M=L.url==="about:blank"?"":L.url,B.update({value:M})}catch{}};I(),setInterval(()=>{I()},2000)});})();
