'use strict';
// Test processes only. Never imported by the application or its production startup.
const net=require('node:net');
const originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const first=Array.isArray(args[0])?args[0][0]:args[0];
  const host=first&&typeof first==='object'?(first.host||first.hostname||'localhost'):
    typeof first==='number'&&typeof args[1]==='string'?args[1]:'localhost';
  if(!['localhost','127.0.0.1','::1'].includes(host))throw Error('EXTERNAL_NETWORK_DISABLED_FOR_OFFLINE_VALIDATION');
  return originalConnect.apply(this,args);
};
const originalFetch=global.fetch;
if(originalFetch)global.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('EXTERNAL_NETWORK_DISABLED_FOR_OFFLINE_VALIDATION');
  return originalFetch(input,options);
};
