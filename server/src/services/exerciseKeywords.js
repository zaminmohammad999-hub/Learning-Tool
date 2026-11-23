// Keyword patterns used by the rule-based (non-AI) transcript matcher.
// `any` decides whether a segment mentions the exercise; `facets` are the individual skills an exercise
// enumerates (e.g. push / pull / fetch) so a gap like "git fetch not evidenced" can be reported precisely.
// These are heuristics for *proposals only*: every match goes to human review before it changes progress.

const r = (s) => new RegExp(s, 'i');

export const EXERCISE_KEYWORDS = {
  // D1 — VS Code & Development Environment
  'D1-C1-E1': { any: r(String.raw`install(ed|ing)? (vs ?code|visual studio code)|\bextensions?\b|marketplace|settings\.json|prettier|eslint`) },
  'D1-C1-E2': {
    any: r(String.raw`\bexplorer\b|source control|search (panel|view|sidebar)|editor tabs?|integrated terminal|command palette|activity bar`),
    facets: {
      Explorer: r(String.raw`\bexplorer\b`),
      Search: r(String.raw`search (panel|view|sidebar)|ctrl\+shift\+f`),
      'Source Control': r('source control'),
      'editor tabs': r(String.raw`editor tabs?|\btabs?\b`),
      'integrated terminal': r(String.raw`integrated terminal|ctrl\+\x60|terminal panel`),
    },
  },
  'D1-C1-E3': { any: r(String.raw`(new|create|created|creating|open|opened|organi[sz]e\w*) (a |the |new )?(project )?(folder|file|directory)|open folder|workspace folder`) },
  'D1-C1-E4': { any: r(String.raw`local (folder|copy|files?)\b.{0,60}(cloud|remote|github)|(cloud|remote) (repo|repository)\b.{0,60}local|onedrive|local (versus|vs\.?) (cloud|remote)`) },
  'D1-C2-E1': {
    any: r(String.raw`(^|[\s>\x60])cd\s|\bpwd\b|get-childitem|\bls\b|\bdir\b`),
    facets: { cd: r(String.raw`(^|[\s>\x60])cd\s`), pwd: r(String.raw`\bpwd\b`), 'Get-ChildItem': r(String.raw`get-childitem|\bls\b|\bdir\b`) },
  },
  'D1-C2-E2': {
    any: r(String.raw`new-item|rename-item|move-item|remove-item|copy-item|\bmkdir\b|\brm\s|-whatif|-confirm|recycle bin`),
    facets: {
      create: r(String.raw`new-item|\bmkdir\b|\bni\s`),
      rename: r(String.raw`rename-item|\bren\s`),
      move: r(String.raw`move-item|\bmv\s`),
      delete: r(String.raw`remove-item|\brm\s|\bdel\s`),
      safeguards: r(String.raw`-whatif|-confirm|recycle bin|double[- ]check|safeguard`),
    },
  },
  'D1-C2-E3': {
    any: r(String.raw`\bnode (-v|--version|\S+\.js)|\bnpm (run|start|install|i|init)\b|\bnpx\b|dev(elopment)? server|localhost:\d+`),
    facets: { 'Node.js command': r(String.raw`\bnode\b|\bnpm\b|\bnpx\b`), 'development server': r(String.raw`dev(elopment)? server|npm run dev|npm start|localhost:\d+`) },
  },
  'D1-C2-E4': {
    any: r(String.raw`not recognized|command not found|\$env:|environment variables?|\bpath\b|absolute path|relative path|error message`),
    facets: { 'command errors': r(String.raw`not recognized|command not found|error message|\berror\b`), paths: r(String.raw`\bpath\b`), 'environment variables': r(String.raw`\$env:|environment variables?`) },
  },
  'D1-C3-E1': {
    any: r(String.raw`\bhtml\b|\bcss\b|javascript|\bjson\b|markdown`),
    facets: { HTML: r(String.raw`\bhtml\b`), CSS: r(String.raw`\bcss\b`), JavaScript: r('javascript'), JSON: r(String.raw`\bjson\b`), Markdown: r('markdown') },
  },
  'D1-C3-E2': {
    any: r(String.raw`package\.json|\.env\b|\bsrc\b|config(uration)? files?|vite\.config|tsconfig`),
    facets: { 'package.json': r(String.raw`package\.json`), '.env': r(String.raw`\.env\b`), src: r(String.raw`\bsrc\b`), 'configuration files': r(String.raw`config(uration)? files?|vite\.config|tsconfig`) },
  },
  'D1-C3-E3': {
    any: r(String.raw`front[- ]?end|back[- ]?end|\bserver\b|database`),
    facets: { frontend: r(String.raw`front[- ]?end`), backend: r(String.raw`back[- ]?end`), server: r(String.raw`\bserver\b`), database: r('database') },
  },
  'D1-C3-E4': { any: r(String.raw`(existing|unfamiliar|someone else'?s) (project|repo|codebase)|project structure|folder structure|walk(ed)? (me )?through the (project|repo|code)`) },
  'D1-C4-E1': { any: r(String.raw`(run|launch|start)\w* (it|the site|the app|the website|the page) locally|live server|localhost|open(ed)? (it )?in the browser`) },
  'D1-C4-E2': { any: r(String.raw`(change|changed|edit|edited|update|updated) (the )?(heading|title|text|colou?r|button|interface|ui|page)|refresh(ed)? the (page|browser)|hot reload`) },
  'D1-C4-E3': {
    any: r(String.raw`browser console|dev ?tools|developer tools|console\.log|problems panel|red squiggl|inspect element|\bf12\b`),
    facets: { 'browser console': r(String.raw`browser console|dev ?tools|developer tools|\bf12\b|console\.log`), 'VS Code errors': r(String.raw`problems panel|red squiggl|vs ?code error`) },
  },
  'D1-C4-E4': { any: r(String.raw`(deliberate|intentional)(ly)? (introduced |broke|break|error|bug)|broke it on purpose|fix(ed)? the (error|bug)|resolv(e|ed) the error`) },

  // D2 — Git & GitHub
  'D2-C1-E1': { any: r(String.raw`git (vs\.?|versus|and) github|github (vs\.?|versus) git|difference between git and github|local (repo|repository)\b.{0,40}remote|remote (repo|repository)\b.{0,40}local`) },
  'D2-C1-E2': {
    any: r(String.raw`git init\b|git status\b|initiali[sz]e (a |the )?(git )?repo`),
    facets: { 'git init': r(String.raw`git init\b|initiali[sz]e (a |the )?(git )?repo`), 'git status': r(String.raw`git status\b`) },
  },
  'D2-C1-E3': {
    any: r(String.raw`git add\b|git commit\b|stag(e|ed|ing) (the |your )?(changes|files)|commit message`),
    facets: { 'git add': r(String.raw`git add\b|stag(e|ed|ing)`), 'git commit': r(String.raw`git commit\b|commit message`) },
  },
  'D2-C1-E4': {
    any: r(String.raw`git log\b|commit history|\.?gitignore`),
    facets: { 'commit history': r(String.raw`git log\b|commit history`), '.gitignore': r(String.raw`\.?gitignore`) },
  },
  'D2-C2-E1': {
    any: r(String.raw`(create|created|creating|new|make|made) (a )?(new )?(public |private )?(github )?repo(sitory)?\b|\b(public|private) repo`),
    facets: { public: r(String.raw`\bpublic\b`), private: r(String.raw`\bprivate\b`) },
  },
  'D2-C2-E2': { any: r(String.raw`git clone\b|\bclon(e|ed|ing)\b`) },
  'D2-C2-E3': {
    any: r(String.raw`git (push|pull|fetch)\b|\bpush(ed|ing)? (it |the changes |your changes )?(to|up to) (origin|github|the remote|main)|\bpull(ed|ing)? (down|from)|\bfetch(ed|ing)?\b`),
    facets: {
      'git push': r(String.raw`git push\b|\bpush(ed|ing)? (it |the changes |your changes )?(to|up to) (origin|github|the remote|main)`),
      'git pull': r(String.raw`git pull\b|\bpull(ed|ing)? (down|from)`),
      'git fetch': r(String.raw`git fetch\b|\bfetch(ed|ing)?\b`),
    },
  },
  'D2-C2-E4': {
    any: r(String.raw`git remote\b|\borigin\b|authenticat|personal access token|\bssh key|credential manager|gh auth`),
    facets: { 'git remote -v': r(String.raw`git remote\b`), origin: r(String.raw`\borigin\b`), authentication: r(String.raw`authenticat|personal access token|\bssh key|credential manager|gh auth|sign(ed)? in`) },
  },
  'D2-C3-E1': {
    any: r(String.raw`git (switch|checkout|branch)\b|feature branch|new branch|switch(ed|ing)? (to (a|the|another) )?branch`),
    facets: { 'create branch': r(String.raw`git (switch -c|checkout -b|branch \S)|new branch|create\w* (a )?(feature )?branch`), 'switch branch': r(String.raw`git (switch|checkout)\b|switch(ed|ing)? (to (a|the|another) )?branch`) },
  },
  'D2-C3-E2': { any: r(String.raw`commit\w* (it )?on (the|a|my|your) (feature )?branch|on the feature branch`) },
  'D2-C3-E3': {
    any: r(String.raw`push(ed)? (the|a|my|your) (feature )?branch|git push -u|set-upstream|pull request|\bPR\b`),
    facets: { 'push branch': r(String.raw`push(ed)? (the|a|my|your) (feature )?branch|git push -u|set-upstream`), 'pull request': r(String.raw`pull request|\bPR\b`) },
  },
  'D2-C3-E4': {
    any: r(String.raw`git merge\b|merge conflict|conflict markers|<<<<<<<|resolv(e|ed|ing) (the |a )?conflict|merg(e|ed|ing) (the )?(branch|PR|pull request)`),
    facets: { merge: r(String.raw`git merge\b|merg(e|ed|ing) (the )?(branch|PR|pull request)`), 'resolve conflict': r(String.raw`conflict`) },
  },
  'D2-C4-E1': { any: r(String.raw`collaborators?|invit(e|ed|ing) (a |someone)|repo(sitory)? permissions|access (level|settings)|(write|read|admin) access`) },
  'D2-C4-E2': {
    any: r(String.raw`\bfork(ed|ing|s)?\b|shar(e|ed|ing) (the |a |your )?repo`),
    facets: { share: r(String.raw`shar(e|ed|ing) (the |a |your )?repo`), fork: r(String.raw`\bfork`) },
  },
  'D2-C4-E3': {
    any: r(String.raw`github issues?|\bissues? tab|open(ed)? an issue|review(ed|ing)? (the |a )?(pull request|PR)|code review|approv(e|ed) the (PR|pull request)`),
    facets: { Issues: r(String.raw`\bissues?\b`), 'PR review': r(String.raw`review(ed|ing)? (the |a )?(pull request|PR)|code review|approv(e|ed) the`) },
  },
  'D2-C4-E4': {
    any: r(String.raw`permission denied|\b403\b|repository not found|access error|git (revert|reset|restore)\b|restor(e|ed) (an )?(earlier|previous|old) version|roll(ed)? back`),
    facets: { 'access error': r(String.raw`permission denied|\b403\b|repository not found|access error`), 'restore earlier version': r(String.raw`git (revert|reset|restore)\b|restor(e|ed)|roll(ed)? back`) },
  },

  // D3 — Claude Code & Vibe Coding
  'D3-C1-E1': {
    any: r(String.raw`(install|set ?up|setup|configur)\w* claude code|claude code (extension|cli)|@anthropic-ai/claude-code`),
    facets: { 'VS Code extension': r(String.raw`extension|vs ?code`), CLI: r(String.raw`\bcli\b|terminal|npm (i|install) -g`) },
  },
  'D3-C1-E2': { any: r(String.raw`permission (mode|prompt|request)s?|tool (use|call|permission)s?|context window|project (context|awareness)|/permissions`) },
  'D3-C1-E3': { any: r(String.raw`(review|inspect|check|look at)\w* (the )?(diff|changes|edits?) (before|first)|accept(ed)? (the )?(edit|change)s?|reject(ed)? (the )?(edit|change)|diff view`) },
  'D3-C1-E4': { any: r(String.raw`ai[- ]generated (change|code|edit)s?|claude (ran|executed|runs) (a |the )?commands?|bash tool|commands? (that )?claude (ran|executed)`) },
  'D3-C2-E1': { any: r(String.raw`requirements? (spec|specification|doc)|\bspecification\b|\bspec\b|\bprd\b`) },
  'D3-C2-E2': {
    any: r(String.raw`\bobjectives?\b|\bconstraints?\b|acceptance criteria`),
    facets: { objectives: r(String.raw`\bobjectives?\b`), constraints: r(String.raw`\bconstraints?\b`), 'acceptance criteria': r('acceptance criteria') },
  },
  'D3-C2-E3': { any: r(String.raw`break(ing)? (it|this|that|the feature|large|big)\w* (down|into)|smaller (changes|tasks|steps|pieces)|one (change|step) at a time`) },
  'D3-C2-E4': { any: r(String.raw`plan mode|plan,? (then )?implement|implement,? (then )?test|test,? (then )?review|review workflow`) },
  'D3-C3-E1': { any: r(String.raw`(build|create|built|created|make|made|generat)\w* (a |the )?(simple )?dashboard|dashboard (with|using) claude`) },
  'D3-C3-E2': {
    any: r(String.raw`navigation|nav ?bar|\bforms?\b|\btables?\b|\bfilters?\b`),
    facets: { navigation: r(String.raw`navigation|nav ?bar`), forms: r(String.raw`\bforms?\b`), tables: r(String.raw`\btables?\b`), filters: r(String.raw`\bfilters?\b`) },
  },
  'D3-C3-E3': { any: r(String.raw`(generated|this) (front[- ]?end|back[- ]?end) code|what (this|the) (generated )?code does|explain(ed)? the (generated )?code|purpose of (the |this )?(component|route|endpoint|file)`) },
  'D3-C3-E4': { any: r(String.raw`without breaking|didn'?t break|regression|existing functionality|still works`) },
  'D3-C4-E1': { any: r(String.raw`\blogs?\b|stack trace|console errors?|network tab|dev ?tools|developer tools`) },
  'D3-C4-E2': { any: r(String.raw`ask(ed)? claude to (diagnose|debug|fix|investigate)|paste(d)? the (error|stack trace|logs?)|gave claude the (error|logs?|stack)`) },
  'D3-C4-E3': { any: r(String.raw`automated tests?|unit tests?|\bvitest\b|\bjest\b|npm test|node --test|test (passed|failed|suite)|\bplaywright\b`) },
  'D3-C4-E4': { any: r(String.raw`git (revert|reset|restore|stash)\b|recover(ed)? (from|with|using) git|roll(ed)? back|undo the (change|commit)`) },

  // D4 — AI Skills, Instructions & Agents
  'D4-C1-E1': {
    any: r(String.raw`claude\.md|agents\.md|instruction scopes?|(user|project)[- ]level (instructions|memory)`),
    facets: { 'CLAUDE.md': r(String.raw`claude\.md`), 'AGENTS.md': r(String.raw`agents\.md`), scopes: r(String.raw`scopes?|(user|project)[- ]level`) },
  },
  'D4-C1-E2': { any: r(String.raw`(creat|writ|wrote|add)\w* (a |the )?claude\.md|/init\b`) },
  'D4-C1-E3': {
    any: r(String.raw`\barchitecture\b|\bconventions?\b|operational boundar|boundaries|do not (touch|modify|edit)`),
    facets: { architecture: r(String.raw`\barchitecture\b`), conventions: r(String.raw`\bconventions?\b`), boundaries: r(String.raw`boundar|do not (touch|modify|edit)`) },
  },
  'D4-C1-E4': { any: r(String.raw`(test|check|verif)\w* (whether|if|that) claude (follows|applies|respects|obeys|used)|follow(s|ed)? the instructions consistently`) },
  'D4-C2-E1': { any: r(String.raw`skill\.md|\bfrontmatter\b|structure of (a )?skill`) },
  'D4-C2-E2': { any: r(String.raw`skills? folder|\.claude/skills|(creat|writ|wrote|build|built)\w* (a |the )?(reusable )?skill\b`) },
  'D4-C2-E3': {
    any: r(String.raw`reference files?|input requirements?|output checks?`),
    facets: { 'reference files': r('reference files?'), 'input requirements': r('input requirements?'), 'output checks': r('output checks?|validat') },
  },
  'D4-C2-E4': { any: r(String.raw`\bgtm\b.{0,40}(skill|cost)|cost[- ]analysis`) },
  'D4-C3-E1': { any: r(String.raw`agents? (vs\.?|versus) skills?|skills? (vs\.?|versus) (agents?|prompts?)|difference between (an? )?(agent|skill|subagent)`) },
  'D4-C3-E2': { any: r(String.raw`agent definition|\.claude/agents|(creat|defin|wrote|writ)\w* (an? |the )?(sub-?)?agent\b|/agents\b`) },
  'D4-C3-E3': {
    any: r(String.raw`(available|allowed|restrict\w*) tools|tool (list|access)|expected output|output (format|schema)`),
    facets: { tools: r(String.raw`tools?`), constraints: r(String.raw`constraint|restrict`), 'expected output': r(String.raw`expected output|output (format|schema)`) },
  },
  'D4-C3-E4': { any: r(String.raw`report(ing)? (sub-?)?agent|delegat(e|ed|ion|ing)`) },
  'D4-C4-E1': { any: r(String.raw`coordinat(ing|or) agent|orchestrat(or|ing|ion)|specialist (roles?|agents?)`) },
  'D4-C4-E2': { any: r(String.raw`workflow\b.{0,60}delegat|delegat\w*.{0,60}(analysis|report)`) },
  'D4-C4-E3': { any: r(String.raw`structured outputs?|json schema|output validation|validat(e|ion) (of )?(the )?output|\bzod\b`) },
  'D4-C4-E4': { any: r(String.raw`approval (step|gate|requirement)|human[- ]in[- ]the[- ]loop|requires? approval|before (any )?external actions?|ask (for )?(permission|approval) before`) },

  // D5 — APIs, MCP & Integrations
  'D5-C1-E1': {
    any: r(String.raw`\bendpoints?\b|\bGET\b request|\bPOST\b request|status codes?|error responses?`),
    facets: { endpoints: r(String.raw`endpoints?`), JSON: r(String.raw`\bjson\b`), GET: r(String.raw`\bGET\b`), POST: r(String.raw`\bPOST\b`), 'error responses': r(String.raw`error responses?|status codes?|\b4\d\d\b|\b5\d\d\b`) },
  },
  'D5-C1-E2': {
    any: r(String.raw`api (docs|documentation|reference)|api key|bearer token|authenticat\w* (a |the )?(test )?request|authorization header|postman|\bcurl\b`),
    facets: { documentation: r(String.raw`docs|documentation|reference`), authentication: r(String.raw`api key|bearer|authenticat|authorization`) },
  },
  'D5-C1-E3': { any: r(String.raw`sample data|response (body|payload|structure)|inspect(ed)? the (json|response|data)|retriev(e|ed) (the |some )?data`) },
  'D5-C1-E4': {
    any: r(String.raw`rate limit|\b429\b|\bretr(y|ies)\b|backoff|error handling`),
    facets: { 'rate limits': r(String.raw`rate limit|\b429\b`), 'error handling': r(String.raw`error handling|retr(y|ies)|backoff`) },
  },
  'D5-C2-E1': {
    any: r(String.raw`\bmcp\b|model context protocol`),
    facets: { servers: r(String.raw`mcp servers?|servers?`), clients: r(String.raw`clients?`), tools: r(String.raw`\btools?\b`), resources: r(String.raw`resources?`) },
  },
  'D5-C2-E2': { any: r(String.raw`claude mcp add|\.mcp\.json|(configur|add|set ?up)\w* (an? |the )?mcp|mcp (config|integration)`) },
  'D5-C2-E3': { any: r(String.raw`/mcp\b|list(ed|ing)? (the |all )?(available )?tools|read[- ]only (operation|tool|call|query)`) },
  'D5-C2-E4': { any: r(String.raw`mcp (vs\.?|versus|or|instead of) (a )?(direct )?api|direct api calls?`) },
  'D5-C3-E1': { any: r(String.raw`spreadsheets?|\bcsv\b|excel|files?,? (vs\.?|versus|or) (a )?database`) },
  'D5-C3-E2': {
    any: r(String.raw`create table|select \*|select .{1,40} from|insert into|\bsql\b`),
    facets: { 'create table': r('create table'), queries: r(String.raw`select|insert into|\bwhere\b`) },
  },
  'D5-C3-E3': {
    any: r(String.raw`\brecords?\b|relationships?|foreign key|primary key|data validation`),
    facets: { records: r(String.raw`\brecords?\b|\brows?\b`), relationships: r(String.raw`relationships?|foreign key`), validation: r('validat') },
  },
  'D5-C3-E4': { any: r(String.raw`(connect|wire|hook)\w* (the |our )?(data|database|db)\b.{0,40}dashboard|dashboard\b.{0,40}(from|reads?|pulls?) (the )?(data|database|db)`) },
  'D5-C4-E1': { any: r(String.raw`\bn8n\b|zapier|make\.com|power automate|automation workflow|workflow (node|trigger)`) },
  'D5-C4-E2': { any: r(String.raw`(retriev|pull|fetch|read)\w* (the )?(data )?from (an |the )?(api|spreadsheet|google sheet|sheet)|http request node|google sheets`) },
  'D5-C4-E3': {
    any: r(String.raw`transform(ed|ing)? (the )?data|map(ped|ping)? (the )?fields|ai[- ](assisted|generated) summary|summari[sz]`),
    facets: { transform: r(String.raw`transform|map(ped|ping)?`), 'AI summary': r(String.raw`summar`) },
  },
  'D5-C4-E4': { any: r(String.raw`(test|simulat)\w* (a |the )?failures?|error (workflow|branch|path)|recovery steps|document(ed)? (the )?recovery`) },

  // D6 — AI Application Development
  'D6-C1-E1': { any: r(String.raw`chat ?bot|chat interface|chat ui`) },
  'D6-C1-E2': { any: r(String.raw`tool (call|use)|function calling|data[- ]query|query (the )?(database|data)`) },
  'D6-C1-E3': { any: r(String.raw`conversation(al)? (context|history)|context window|\bretrieval\b|\brag\b`) },
  'D6-C1-E4': { any: r(String.raw`validat\w* (the )?(responses?|answers?)|hallucinat|ground(ed|ing)|check(ed)? against (the )?(data|database)`) },
  'D6-C2-E1': { any: r(String.raw`api keys?|\.env\b|environment variables?|\bsecrets?\b`) },
  'D6-C2-E2': {
    any: r(String.raw`authentication|authori[sz]ation|\bpermissions?\b|sensitive data|\bpii\b|least privilege`),
    facets: { authentication: r('authentication'), permissions: r(String.raw`permissions?|authori[sz]ation`), 'sensitive data': r(String.raw`sensitive|\bpii\b|private data`) },
  },
  'D6-C2-E3': { any: r(String.raw`\bdeploy(ed|ing|ment)?\b|vercel|netlify|render\.com|railway|\bhosting\b`) },
  'D6-C2-E4': { any: r(String.raw`deployment (error|log)s?|build (log|error)s?|build failed|production url|(test|check)\w* the deployed`) },
  'D6-C3-E1': {
    any: r(String.raw`gtm os|acceptance criteria`),
    facets: { 'GTM OS feature': r(String.raw`gtm os`), 'acceptance criteria': r('acceptance criteria') },
  },
  'D6-C3-E2': {
    any: r(String.raw`feature branch|implementation plan`),
    facets: { 'feature branch': r('feature branch'), 'implementation plan': r(String.raw`implementation plan|plan mode`) },
  },
  'D6-C3-E3': { any: r(String.raw`vertical slice|end[- ]to[- ]end (feature|slice)|working (feature|slice)`) },
  'D6-C3-E4': {
    any: r(String.raw`run (the )?tests|npm test|review(ed)? (the )?changes|prepar\w* (a |the )?(pull request|PR)`),
    facets: { tests: r(String.raw`tests?`), review: r(String.raw`review`), 'pull request': r(String.raw`pull request|\bPR\b`) },
  },
  'D6-C4-E1': { any: r(String.raw`demo(nstrate|nstrated|nstration)?\b|walk(ed)? through the (feature|app)`) },
  'D6-C4-E2': {
    any: r(String.raw`\barchitecture\b|data flow|explain(ed)? (the )?files|how it works`),
    facets: { files: r(String.raw`files`), architecture: r('architecture'), 'data flow': r('data flow') },
  },
  'D6-C4-E3': { any: r(String.raw`diagnos\w*|small change|fix(ed)? (an |the |one )?issue`) },
  'D6-C4-E4': { any: r(String.raw`\bmerg(e|ed)\b|\bdeploy(ed)?\b|document(ed)? (the )?outcome|release notes|changelog`) },
};
