(function(root){
  const fields=[
    {key:'impressions',label:'Impression',unit:''},
    {key:'clicks',label:'Click',unit:''},
    {key:'ctr',label:'CTR',unit:'%'}
  ];
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  function metrics(link){
    const total=link?.result?.total||{};
    const impressions=number(total.impressions);
    const clicks=number(total.clicks);
    const rawCtr=number(total.ctr);
    return {
      impressions,
      clicks,
      ctr:rawCtr!=null?rawCtr:impressions!=null&&impressions>0&&clicks!=null?clicks/impressions*100:null
    };
  }
  function compare(left,right){
    const a=metrics(left),b=metrics(right);
    return fields.map(field=>{
      const before=a[field.key],after=b[field.key];
      const absolute=before!=null&&after!=null?after-before:null;
      return {key:field.key,label:field.label,unit:field.unit,before,after,absolute,percent:absolute!=null&&before!==0?absolute/before*100:null};
    });
  }
  function sortLinks(links){
    return links.filter(link=>link?.id).slice().sort((a,b)=>String(a.reportMonth||'').localeCompare(String(b.reportMonth||''))||String(a.name||'').localeCompare(String(b.name||''),'vi')||String(a.id).localeCompare(String(b.id)));
  }
  function defaultSelection(links){
    const sorted=sortLinks(links), right=sorted.at(-1), left=sorted.at(-2);
    return {
      leftLink:left?.id||'',
      rightLink:right?.id||''
    };
  }
  root.ReportComparison={fields,metrics,compare,sortLinks,defaultSelection};
})(typeof window!=='undefined'?window:globalThis);
