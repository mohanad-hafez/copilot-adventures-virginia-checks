const DAY = 86400000;
function dailyReport(input) {
  const now = Date.parse(input.now), cutoff = now - DAY;
  if (!Number.isFinite(now)) throw new Error('Invalid reference clock');
  const recent = time => { const date = Date.parse(time); return date >= cutoff && date <= now; };
  const commits = input.commits.filter(commit => recent(commit.pushed_at));
  const prs = input.pull_requests.filter(pr => [pr.created_at, pr.merged_at, pr.closed_at].some(recent));
  const issues = input.issues.filter(issue => !issue.pull_request && [issue.created_at, issue.closed_at].some(recent));
  const failures = input.workflow_runs.filter(run => run.conclusion === 'failure' && recent(run.updated_at));
  const sections = [
    ['## 📝 Commits', commits.map(commit => `- ${commit.sha.slice(0, 7)} · ${commit.author} · ${commit.message.split('\n')[0]}`), 'No commits in the past 24 hours.'],
    ['## 🔀 Pull Requests', prs.map(pr => `- #${pr.number} · ${pr.title} · @${pr.author} · ${pr.merged_at ? 'merged' : pr.state}`), 'No pull request activity in the past 24 hours.'],
    ['## 🐛 Issues', issues.map(issue => `- #${issue.number} · ${issue.title} · @${issue.author} · ${issue.state}`), 'No issue activity in the past 24 hours.'],
    ['## ⚠️ CI/CD Failures', failures.map(run => `- ${run.name} · ${run.event} · ${run.html_url}`), 'No CI/CD failures in the past 24 hours.'],
  ];
  const body = sections.map(([heading, lines, empty]) => heading + '\n\n' + (lines.length ? lines.join('\n') : empty)).join('\n\n');
  return { actions: [{ kind: 'create_issue', title: `📊 Daily Activity Report – ${new Date(now).toISOString().slice(0, 10)}`, labels: ['daily-report'], body }], counts: { commits: commits.length, pull_requests: prs.length, issues: issues.length, failures: failures.length } };
}


module.exports = { dailyReport };
