import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const context={window:{}};
vm.runInNewContext(readFileSync(new URL('../public/comparison.js',import.meta.url),'utf8'),context);
const comparison=context.window.ReportComparison;

test('comparison reports signed deltas and leaves zero-base percentages undefined',()=>{
  const rows=comparison.compare(
    {result:{total:{impressions:100,clicks:10,ctr:10}}},
    {result:{total:{impressions:150,clicks:15,ctr:10}}}
  );
  assert.deepEqual(Array.from(rows,(row=>[row.key,row.before,row.after,row.absolute,row.percent])),[
    ['impressions',100,150,50,50],
    ['clicks',10,15,5,50],
    ['ctr',10,10,0,0]
  ]);
  assert.equal(comparison.compare({result:{total:{impressions:0,clicks:0}}},{result:{total:{impressions:3,clicks:1}}})[0].percent,null);
  assert.equal(comparison.compare({},{result:{total:{impressions:3,clicks:null}}})[1].absolute,null);
});

test('default selection chooses two latest reports by stable id and allows same-month reports',()=>{
  const links=[
    {id:'sep-ad',name:'Ad report',source:'Admicro',reportMonth:'2026-09'},
    {id:'aug-24',name:'August report',source:'24h',reportMonth:'2026-08'},
    {id:'sep-24',name:'September report',source:'24h',reportMonth:'2026-09'},
    {id:'jul-24',name:'July report',source:'24h',reportMonth:'2026-07'}
  ];
  const selected=comparison.defaultSelection(links);
  assert.equal(selected.leftLink,'sep-ad');
  assert.equal(selected.rightLink,'sep-24');
  assert.notEqual(selected.leftLink,selected.rightLink);
  assert.equal(comparison.defaultSelection([{id:'only',name:'Only report',reportMonth:'2026-09'}]).leftLink,'');
  assert.equal(comparison.defaultSelection([{id:'only',name:'Only report',reportMonth:'2026-09'}]).rightLink,'only');
});

test('comparison polling preserves select options and both selections',async()=>{
  class Element{
    constructor(id,tag='div'){this.id=id;this.tagName=tag;this._html='';this.options=[];this.innerHTMLWrites=0;this.listeners={};this.value='';}
    get innerHTML(){return this._html;}
    set innerHTML(value){this._html=String(value);this.innerHTMLWrites++;if(this.tagName==='SELECT')this.options=[...this._html.matchAll(/<option value="([^"]*)"[^>]*>(.*?)<\/option>/g)].map(m=>({value:m[1],label:m[2]}));}
    addEventListener(type,fn){this.listeners[type]=fn;}
    dispatchEvent(event){this.listeners[event.type]?.(event);}
    setAttribute(){} closest(){return null;} scrollIntoView(){} reset(){} showModal(){} close(){}
  }
  const ids=['message','monthFilter','all','cards','summary','compareLeftLink','compareRightLink','compareStatus','compareResults','comparison','compare','closeComparison','detail','add','close','editor','form','url','name','from','to','reportMonth','preview','previewText'];
  const elements=new Map(ids.map(id=>[id,new Element(id,id==='monthFilter'||id.startsWith('compare')&&id.endsWith('Link')?'select':'div')]));
  const document={activeElement:null,querySelector(selector){return elements.get(selector.slice(1));}};
  const links=['a','b','c'].map((id,i)=>({id,name:`Report ${id.toUpperCase()}`,source:'Admicro',reportMonth:`2026-0${i+1}`,from:'2026-09-01',to:'2026-09-08',result:{total:{impressions:100+i,clicks:10+i,ctr:10}}}));
  const response={links,months:[],groups:[]};
  const context={window:{ReportComparison:comparison},document,localStorage:{getItem(){return '';},setItem(){}},fetch:async()=>({ok:true,json:async()=>response}),setTimeout(){return 0;},clearTimeout(){}};
  vm.runInNewContext(`${readFileSync(new URL('../public/links.js',import.meta.url),'utf8')}\nglobalThis.__renderComparison=renderComparison;globalThis.__refresh=refresh;`,context);
  await new Promise(resolve=>setImmediate(resolve));
  const left=elements.get('compareLeftLink'),right=elements.get('compareRightLink');
  const leftOptions=left.options,rightOptions=right.options,writes=[left.innerHTMLWrites,right.innerHTMLWrites];
  await context.__refresh();
  assert.strictEqual(left.options,leftOptions);assert.strictEqual(right.options,rightOptions);assert.deepEqual([left.innerHTMLWrites,right.innerHTMLWrites],writes);
  const leftInitial=left.value,rightInitial=right.value;left.value='a';left.onchange({target:left});assert.equal(left.value,'a');assert.equal(right.value,rightInitial);
  right.value='b';right.onchange({target:right});assert.equal(left.value,'a');assert.equal(right.value,'b');
  response.links[0].name='Renamed';document.activeElement=left;await context.__refresh();console.log('DEBUG',left.innerHTMLWrites,left.options,leftOptions);assert.strictEqual(left.options,leftOptions);document.activeElement=null;left.dispatchEvent({type:'blur'});assert.notStrictEqual(left.options,leftOptions);
  assert.equal(rightInitial,'c');
});
