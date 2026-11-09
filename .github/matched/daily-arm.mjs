import fs from 'node:fs';
import assert from 'node:assert/strict';
import {collectActivity,reportActivity} from './daily_activity.mjs';

const {inputs} = JSON.parse(fs.readFileSync('daily.json','utf8'));
const {repository,end,paths} = inputs.window;
const read = async path => {
  const key = Object.keys(paths).find(name=>paths[name]===path);
  assert(key,'Unexpected endpoint');
  return inputs[key];
};
const data = await collectActivity({repository,end,read});
const expected = reportActivity(data);
assert.equal(data.commits.length,1);
assert.equal(data.pull_requests.length+data.issues.length+data.failed_runs.length,0);
let result = expected;
if (process.env.ARM==='agent') {
  const calls = fs.readFileSync('evidence/tools.jsonl','utf8').trim().split('\n').map(JSON.parse);
  assert(calls.every(call=>!call.error));
  assert.deepEqual([...new Set(calls.slice(0,-1).map(call=>call.args.name))].sort(),Object.keys(inputs).sort());
  assert.equal(calls.at(-1).name,'publish_result');
  result = JSON.parse(calls.at(-1).args.body);
  assert.equal(result.title,expected.title);
  assert.deepEqual(result.labels,expected.labels);
  const lines = result.body.trim().split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const headings = expected.body.split('\n').filter(line=>line.startsWith('## '));
  assert.deepEqual(lines.filter(line=>line.startsWith('## ')),headings);
  assert.equal(lines.length,8);
  const commit = data.commits[0];
  assert(lines[1].includes(commit.sha.slice(0,7))&&lines[1].includes(commit.author)&&lines[1].includes(commit.message));
  assert(!/https?:\/\//.test(lines[1])||lines[1].includes(commit.url));
  assert(/^no (?:pull request|pr)/i.test(lines[3]));
  assert(/^no issue/i.test(lines[5]));
  assert(/^no (?:ci\/cd|workflow|failed)/i.test(lines[7]));
  assert(!/@[a-z0-9]/i.test(result.body));
  fs.writeFileSync('evidence/agent-proposal.json',JSON.stringify(result));
}
// The same fixed Markdown layout is used for the published report after checking the agent's facts.
fs.writeFileSync('evidence/result.json',JSON.stringify(expected));
fs.writeFileSync('evidence/capture.json',JSON.stringify(data));
