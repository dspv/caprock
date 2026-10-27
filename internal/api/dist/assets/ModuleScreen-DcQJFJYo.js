import{c as e,i as t,o as n,t as r}from"./jsx-runtime-qHe2BjQo.js";import{at as i,ct as a,st as o}from"./index-CFSMJmeJ.js";var s=e(),c=`caprock-module:`,l=/^[a-z][a-z0-9-]{0,31}$/;function u(e,t,n){if(!l.test(e)||typeof n!=`string`||typeof t!=`string`)return null;let r=t.toUpperCase();if(!n.startsWith(`/`)||n.startsWith(`//`)||/[\s\\#\u0000-\u001f\u007f]/.test(n))return null;let i=n.indexOf(`?`),a=i<0?n:n.slice(0,i);if(/%(2e|2f|5c)/i.test(a))return null;let o=a.slice(1).split(`/`);if(o.some((e,t)=>e===`.`||e===`..`||e===``&&t!==o.length-1))return null;let s=`/x/${e}/`;if(a.startsWith(s))return r===`GET`||r===`HEAD`?n:null;let c=`/v1/x/${e}/docs/`;return a.startsWith(c)&&a.length>c.length&&!a.endsWith(`/`)?o.length>6?null:[`GET`,`HEAD`,`PUT`,`PATCH`,`DELETE`].includes(r)?n:null:r===`POST`&&n===`/v1/x/${e}/telegram`||r===`POST`&&n===`/v1/x/${e}/notify`||r===`PATCH`&&n.startsWith(`/v1/x/${e}/telegram/`)&&/^\d{1,19}$/.test(n.slice(`/v1/x/${e}/telegram/`.length))||r===`PUT`&&n===`/v1/x/${e}/attention`?n:null}var d=String.raw`(function (cfg) {
  'use strict';
  var host = window.parent, seq = 0, waiting = {}, images = {};
  function own(u) {
    try { var url = new URL(String(u), document.baseURI); return url.protocol === cfg.scheme ? url.pathname + url.search : null; } catch (e) { return null; }
  }
  function call(method, path, headers, body) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting[id] = resolve;
      host.postMessage({ type: 'caprock:bridge', secret: cfg.secret, id: id, method: method, path: path, headers: headers, body: body }, cfg.origin);
    });
  }
  function applyTheme(t) {
    var el = document.documentElement;
    if (t.theme === 'light' || t.theme === 'dark') { el.setAttribute('data-theme', t.theme); el.style.colorScheme = t.theme; }
    var v = t.vars || {};
    for (var k in v) if (/^--(color|font)-/.test(k) && typeof v[k] === 'string') el.style.setProperty(k, v[k]);
  }
  addEventListener('message', function (e) {
    if (e.source !== host || !e.data || typeof e.data !== 'object') return;
    var d = e.data;
    if (d.type === 'caprock:bridge-reply' && d.secret === cfg.secret && waiting[d.id]) { var w = waiting[d.id]; delete waiting[d.id]; w(d); }
    else if (d.type === 'caprock:theme') applyTheme(d);
    else if (d.type === 'caprock:route' && typeof d.hash === 'string' && /^#\S{1,511}$/.test(d.hash)) location.hash = d.hash;
  });
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    var path = own(req ? req.url : input);
    if (path === null) return nativeFetch.apply(this, arguments);
    var method = String(init.method || (req && req.method) || 'GET').toUpperCase();
    var headers = {};
    new Headers(init.headers || (req && req.headers) || {}).forEach(function (v, k) { headers[k] = v; });
    var body = init.body != null ? new Response(init.body).arrayBuffer()
      : req && method !== 'GET' && method !== 'HEAD' ? req.arrayBuffer() : Promise.resolve(null);
    return body.then(function (b) { return call(method, path, headers, b); }).then(function (r) {
      if (r.error) throw new TypeError(r.error);
      var empty = r.status === 204 || r.status === 304 || method === 'HEAD';
      return new Response(empty ? null : r.body, { status: r.status, statusText: r.statusText || '', headers: r.headers || {} });
    });
  };
  function fixImage(img) {
    var raw = img.getAttribute('src');
    var path = raw ? own(raw) : null;
    if (path === null) return;
    if (!images[path]) images[path] = call('GET', path, {}, null).then(function (r) {
      if (r.error || r.status !== 200) throw new Error('not found');
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = rej;
        fr.readAsDataURL(new Blob([r.body], { type: (r.headers && r.headers['content-type']) || '' }));
      });
    });
    images[path].then(function (url) { if (img.getAttribute('src') === raw) img.setAttribute('src', url); }, function () { delete images[path]; });
  }
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'IMG') fixImage(node);
    var list = node.querySelectorAll('img[src]');
    for (var i = 0; i < list.length; i++) fixImage(list[i]);
  }
  new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      if (m.type === 'attributes') { if (m.target.tagName === 'IMG') fixImage(m.target); }
      else for (var i = 0; i < m.addedNodes.length; i++) scan(m.addedNodes[i]);
    });
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  document.addEventListener('DOMContentLoaded', function () { scan(document.documentElement); });
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || !e.target || !e.target.closest) return;
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') { e.preventDefault(); if (location.hash !== href) location.hash = href; }
    else if (own(href) !== null) e.preventDefault();
  });
})`;function f(e){return e.replace(/</g,`\\u003c`)}function p(e,t){return`data:${e};charset=utf-8,${encodeURIComponent(t)}`}function m(e,t,n){if(!/^(\.\.?\/|\/(?!\/))/.test(t)&&!/^[\w.-][^:]*$/.test(t))return null;try{let r=new URL(t,c+n);if(r.protocol!==`caprock-module:`)return null;let i=r.pathname;return i.startsWith(`/x/${e}/`)&&u(e,`GET`,i)?i:null}catch{return null}}function h(e,t,n){let r=[];return{code:t.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])((?:\.\.?\/|\/)[^'"\n]*)\2/g,(t,i,a,o)=>{let s=m(e,o,n);return s?(r.push(s),`${i}${a}${c}${s}${a}`):t}),deps:r}}async function g(e,t,n,r,i){let a=new Map;for(let o of t.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)){let t=m(e,o[2].trim(),n);t&&!a.has(t)&&(i.take(t),a.set(t,await r.dataURL(t)))}return t.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g,(t,r,i)=>{let o=m(e,i.trim(),n),s=o?a.get(o):void 0;return s?`url("${s}")`:t})}var _=class{files=0;bytes=0;take(e,t=0){if(this.files++,this.bytes+=t,this.files>500||this.bytes>67108864)throw Error(`the module is too large to open on a phone (at ${e})`)}};async function v(e,t,n){if(!l.test(e))throw Error(`not a module id`);let r=`/x/${e}/`,i=new _,a=await t.text(r);i.take(r,a.length);let o=new DOMParser().parseFromString(a,`text/html`),s=new Map,u=async n=>{if(s.has(n))return;s.set(n,``);let r=await t.text(n);i.take(n,r.length);let{code:a,deps:o}=h(e,r,n);s.set(n,p(`text/javascript`,a));for(let e of o)await u(e)};for(let n of Array.from(o.querySelectorAll(`script`))){let a=(n.getAttribute(`type`)??``).trim().toLowerCase()===`module`,o=n.getAttribute(`src`);if(o===null){if(!a)continue;let{code:t,deps:i}=h(e,n.textContent??``,r);n.textContent=t;for(let e of i)await u(e);continue}let c=m(e,o,r);if(c){if(a)await u(c),n.setAttribute(`src`,s.get(c));else{let e=await t.text(c);i.take(c,e.length),n.setAttribute(`src`,p(`text/javascript`,e))}}}for(let n of Array.from(o.querySelectorAll(`link[href]`))){let a=(n.getAttribute(`rel`)??``).toLowerCase().split(/\s+/),o=m(e,n.getAttribute(`href`),r);if(o){if(a.includes(`stylesheet`)){let r=await t.text(o);i.take(o,r.length),n.setAttribute(`href`,p(`text/css`,await g(e,r,o,t,i)))}else n.remove()}}for(let n of Array.from(o.querySelectorAll(`style`)))n.textContent=await g(e,n.textContent??``,r,t,i);o.querySelectorAll(`base`).forEach(e=>e.remove());let v=o.documentElement;v.setAttribute(`data-theme`,n.theme.theme),v.style.colorScheme=n.theme.theme;for(let[e,t]of Object.entries(n.theme.vars))v.style.setProperty(e,t);let y=o.head,b=o.createElement(`base`);b.setAttribute(`href`,`${c}${r}`);let x=o.createElement(`script`);x.setAttribute(`type`,`importmap`);let S={};for(let[e,t]of s)S[c+e]=t;x.textContent=f(JSON.stringify({imports:S}));let C=o.createElement(`script`),w={scheme:c,secret:n.secret,origin:n.origin};return C.textContent=`${d}(${f(JSON.stringify(w))});`,y.prepend(b,x,C),`<!doctype html>\n${v.outerHTML}`}function y(e){let t=e;return!!t&&typeof t==`object`&&t.type===`caprock:bridge`&&typeof t.secret==`string`&&typeof t.id==`number`&&typeof t.method==`string`&&typeof t.path==`string`}var b=[`content-type`,`accept`];async function x(e,n,r,i=(e,t)=>fetch(e,t)){if(!y(e)||e.secret!==r||!r)return null;let a={type:`caprock:bridge-reply`,secret:r,id:e.id},o=e.method.toUpperCase(),s=u(n,o,e.path);if(!s){let e=new TextEncoder().encode(JSON.stringify({error:`a module on a phone reaches only its own files and store`})).buffer;return{...a,status:403,statusText:`Forbidden`,headers:{"content-type":`application/json`},body:e}}let c={};for(let[t,n]of Object.entries(e.headers??{}))b.includes(t.toLowerCase())&&typeof n==`string`&&(c[t.toLowerCase()]=n);let l=o!==`GET`&&o!==`HEAD`;l&&!c[`content-type`]&&(c[`content-type`]=`application/json`);let d=t();d&&(c[`X-Caprock-Device`]=d);try{let t=await i(s,{method:o,headers:c,body:l&&e.body?e.body:void 0}),n={},r=t.headers.get(`content-type`);r&&(n[`content-type`]=r);let u=o===`HEAD`||t.status===204||t.status===304?null:await t.arrayBuffer();return{...a,status:t.status,statusText:t.statusText,headers:n,body:u}}catch(e){return{...a,error:e instanceof Error?e.message:String(e)}}}function S(e,n=(e,t)=>fetch(e,t)){let r=async r=>{if(!r.startsWith(`/x/${e}/`)||!u(e,`GET`,r))throw Error(`not the module's own file: ${r}`);let i=t(),a=await n(r,{headers:i?{"X-Caprock-Device":i}:{}});if(!a.ok)throw Error(`${r}: ${a.status}`);return a};return{text:async e=>(await r(e)).text(),dataURL:async e=>{let t=await(await r(e)).blob();return await new Promise((e,n)=>{let r=new FileReader;r.onload=()=>e(String(r.result)),r.onerror=()=>n(r.error),r.readAsDataURL(t)})}}}function C(){let e=new Uint8Array(16);return crypto.getRandomValues(e),Array.from(e,e=>e.toString(16).padStart(2,`0`)).join(``)}var w=r(),T={height:`calc(100dvh - 6rem)`,minHeight:420};function E(e,t,n){(0,s.useEffect)(()=>{if(!t)return;let r=new MutationObserver(()=>{e.current&&i(e.current,o(),n)});return r.observe(document.documentElement,{attributes:!0,attributeFilter:[`data-theme`,`data-dark`,`data-tone`,`data-glow`,`style`]}),()=>r.disconnect()},[e,t,n])}function D({id:e,to:t}){let r=a()?.installed?.find(t=>t.id===e);return r?n()?(0,w.jsx)(k,{mod:r,to:t}):(0,w.jsx)(O,{mod:r,to:t}):null}function O({mod:e,to:t}){let n=(0,s.useRef)(null);E(n,!0,!1);let r=document.documentElement.getAttribute(`data-theme`)===`light`?`light`:`dark`;return(0,w.jsx)(`iframe`,{ref:n,"data-module":e.id,title:e.name,src:`${e.url}?theme=${r}${t??``}`,onLoad:e=>i(e.currentTarget),className:`block w-full rounded-md border border-border bg-bg`,style:T})}function k({mod:e,to:t}){let n=(0,s.useRef)(null),r=(0,s.useMemo)(()=>C(),[]),[i,a]=(0,s.useState)(),[c,l]=(0,s.useState)(``);E(n,!!i,!0);let u=(0,s.useCallback)(()=>{t&&n.current?.contentWindow?.postMessage({type:`caprock:route`,hash:t},`*`)},[t]);return(0,s.useEffect)(u,[u]),(0,s.useEffect)(()=>{let t=!0;return v(e.id,S(e.id),{secret:r,origin:window.location.origin,theme:o()}).then(e=>{t&&a(e)}).catch(e=>{t&&l(e instanceof Error?e.message:String(e))}),()=>{t=!1}},[e.id,r]),(0,s.useEffect)(()=>{let t=t=>{let i=n.current?.contentWindow;i&&t.source===i&&x(t.data,e.id,r).then(e=>{e&&i.postMessage(e,`*`,e.body?[e.body]:[])})};return window.addEventListener(`message`,t),()=>window.removeEventListener(`message`,t)},[e.id,r]),c?(0,w.jsxs)(`p`,{"data-module-error":!0,className:`p-3 text-[13px] text-danger`,children:[e.name,` could not open here: `,c]}):i?(0,w.jsx)(`iframe`,{ref:n,"data-module":e.id,title:e.name,sandbox:`allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads`,allow:`clipboard-write`,srcDoc:i,onLoad:u,className:`block w-full rounded-md border border-border bg-bg`,style:T}):(0,w.jsxs)(`p`,{className:`p-3 text-[13px] text-fg-muted`,children:[`Opening `,e.name,`…`]})}export{D as ModuleScreen};