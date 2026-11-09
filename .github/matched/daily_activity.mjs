import fs from 'node:fs';
const DAY_MS=24*60*60*1000, PAGE_SIZE=100, EVENT_PAGES=3, MAX_PAGES=20;
const zeroSha=/^0{40}$/;
export async function collectActivity({repository,end,read}) {
  const endMs=Date.parse(end),startMs=endMs-DAY_MS;
  if(!Number.isFinite(endMs))throw Error('Invalid capture clock');
  const inWindow=value=>Number.isFinite(Date.parse(value))&&Date.parse(value)>=startMs&&Date.parse(value)<=endMs;
  const events=[];let eventsComplete=false;
  for(let page=1;page<=EVENT_PAGES;page++){
    const batch=await read(`repos/${repository}/events?per_page=${PAGE_SIZE}&page=${page}`);
    if(!Array.isArray(batch))throw Error('Invalid event list');events.push(...batch.filter(e=>inWindow(e.created_at)));
    if(batch.length<PAGE_SIZE||batch.some(e=>Date.parse(e.created_at)<startMs)){eventsComplete=true;break}
  }
  if(!eventsComplete)throw Error('Event feed capped before window coverage; no complete report');
  const commits=new Map(),pullRequests=[],issues=[];
  for(const e of events){
    if(e.type==='PushEvent'){
      const {before,head,ref}=e.payload;
      if(zeroSha.test(head))continue;
      if(!/^[a-f0-9]{40}$/.test(before)||!/^refs\/heads\//.test(ref)||zeroSha.test(before)||!/^[a-f0-9]{40}$/.test(head))throw Error('Unsupported new-branch or ambiguous push history; inspect before reporting');
      let observed=0,total=null;
      for(let page=1;page<=MAX_PAGES;page++){
        const comparison=await read(`repos/${repository}/compare/${before}...${head}?per_page=${PAGE_SIZE}&page=${page}`);
        if(!Array.isArray(comparison.commits)||!Number.isSafeInteger(comparison.total_commits))throw Error('Invalid commit comparison');
        total=comparison.total_commits;observed+=comparison.commits.length;
        for(const c of comparison.commits){
          const existing=commits.get(c.sha);
          if(existing){existing.branches=[...new Set([...existing.branches,ref])];continue}
          commits.set(c.sha,{sha:c.sha,author:c.author?.login||c.commit.author.name,message:c.commit.message.split(/\r?\n/)[0],pushed_at:e.created_at,branches:[ref],url:`https://github.com/${repository}/commit/${c.sha}`});
        }
        if(observed>=total)break;
        if(comparison.commits.length===0||page===MAX_PAGES)throw Error('Incomplete pushed commit enumeration');
      }
      if(observed!==total)throw Error('Push comparison total mismatch');
    }else if(e.type==='PullRequestEvent'&&['opened','closed'].includes(e.payload.action)){
      const p=e.payload.pull_request;if(!p||!p.number)throw Error('Missing PR event metadata');
      pullRequests.push({number:p.number,title:p.title,author:p.user.login,status:e.payload.action==='closed'&&p.merged?'merged':e.payload.action,time:e.created_at,url:`https://github.com/${repository}/pull/${p.number}`,event_id:e.id});
    }else if(e.type==='IssuesEvent'&&['opened','closed'].includes(e.payload.action)){
      const i=e.payload.issue;if(!i||!i.number)throw Error('Missing issue event metadata');
      issues.push({number:i.number,title:i.title,author:i.user.login,status:e.payload.action,time:e.created_at,url:`https://github.com/${repository}/issues/${i.number}`,event_id:e.id});
    }
  }
  const failedRuns=[];let runsComplete=false,seenRuns=0;
  for(let page=1;page<=MAX_PAGES;page++){
    const batch=await read(`repos/${repository}/actions/runs?status=failure&per_page=${PAGE_SIZE}&page=${page}`);
    if(!Array.isArray(batch.workflow_runs)||!Number.isSafeInteger(batch.total_count))throw Error('Invalid failure runs');
    seenRuns+=batch.workflow_runs.length;
    for(const r of batch.workflow_runs)if(r.status==='completed'&&r.conclusion==='failure'&&inWindow(r.updated_at))failedRuns.push({id:r.id,name:r.name,event:r.event,created_at:r.created_at,updated_at:r.updated_at,url:r.html_url});
    // Exhaust the failure list; an old-created run can finish inside this window.
    if(seenRuns>=batch.total_count){runsComplete=true;break}
    if(batch.workflow_runs.length===0)throw Error('Incomplete failure-run list');
  }
  if(!runsComplete)throw Error('Failure runs exceed bounded complete scan');
  return {schema:1,repository,start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString(),commits:[...commits.values()],pull_requests:pullRequests,issues,failed_runs:failedRuns,coverage:{events_complete:true,failure_runs_complete:true,event_ids:events.map(e=>e.id),failure_runs_scanned:seenRuns,limit:'Recorded GitHub Events API state; event delivery can lag. Commit inclusion uses push time, not commit author dates.'},model_calls:0};
}
const safe=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('`','&#96;').replaceAll('@','@\u200b').replace(/[\r\n]+/g,' ');
export function reportActivity(data){
  const sections=[
    ['## 📝 Commits',data.commits.map(c=>`- [\`${c.sha.slice(0,7)}\`](${c.url}) — \`${safe(c.author)}\` — ${safe(c.message)}`),'No commits in the past 24 hours.'],
    ['## 🔀 Pull Requests',data.pull_requests.map(p=>`- [#${p.number}](${p.url}) — ${safe(p.title)} — \`${safe(p.author)}\` — ${p.status}`),'No pull request activity in the past 24 hours.'],
    ['## 🐛 Issues',data.issues.map(i=>`- [#${i.number}](${i.url}) — ${safe(i.title)} — \`${safe(i.author)}\` — ${i.status}`),'No issue activity in the past 24 hours.'],
    ['## ⚠️ CI/CD Failures',data.failed_runs.map(r=>`- [${safe(r.name)}](${r.url}) — ${safe(r.event)} — failure`),'No CI/CD failures in the past 24 hours.']
  ];
  const body=sections.map(([title,rows,empty])=>title+'\n\n'+(rows.length?rows.join('\n'):empty)).join('\n\n');
  if(body.length>60000)throw Error('Report too large; do not silently truncate');
  return {title:'📊 Daily Activity Report – '+data.end.slice(0,10),labels:['daily-report'],body};
}
export async function runDaily({github,context}){
  const repository=`${context.repo.owner}/${context.repo.repo}`;
  if(repository!=='mohanad-hafez/copilot-adventures-virginia-checks')throw Error('Unexpected target');
  if(fs.existsSync('daily-publication.json'))throw Error('Prior publication receipt; inspect before replay');
  const requests=[];
  const {data:run}=await github.rest.actions.getWorkflowRun({...context.repo,run_id:context.runId});
  const read=async path=>{const {data}=await github.request('GET /'+path);requests.push({path});return data};
  const data=await collectActivity({repository,end:run.created_at,read});
  fs.writeFileSync('daily-capture.json',JSON.stringify({...data,requests},null,2)+'\n');
  const report=reportActivity(data),receipt={status:'delivery_started',report};
  fs.writeFileSync('daily-publication.json',JSON.stringify(receipt,null,2)+'\n');
  try{const {data:issue}=await github.rest.issues.create({...context.repo,...report});receipt.status='created';receipt.issue={number:issue.number,url:issue.html_url}}
  catch(error){receipt.status='delivery_uncertain';throw error}
  finally{fs.writeFileSync('daily-publication.json',JSON.stringify(receipt,null,2)+'\n')}
}
