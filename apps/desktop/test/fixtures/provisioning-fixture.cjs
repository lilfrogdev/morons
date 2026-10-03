// Offline native-input fixture. No provider, Cloudflare, storage or network calls.
const readline = require('node:readline');
let accountIds = [], preview;
readline.createInterface({input:process.stdin}).on('line', line => {
  let r; try { r = JSON.parse(line); } catch { return; }
  let result;
  if (r.op === 'connect' && r.credentialEntryApproved === true && r.scopeConfirmed === true) {
    accountIds = r.accountIds; result = {state:'connected',expiresAt:Date.now()+600000};
  } else if (r.op === 'listAccounts') result = accountIds.map(id=>({id,name:'Offline fixture account'}));
  else if (r.op === 'prepare' && accountIds.includes(r.accountId)) {
    preview = {id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',expiresAt:Date.now()+300000,account:{id:r.accountId,name:'Offline fixture account'},workerName:r.workerName+"-"+"b".repeat(32),endpoint:'https://fixture.morons.workers.dev',bundleSha256:'a'.repeat(64),resources:['Fixture Worker','Fixture ROOT SQLite Durable Object'],secretBindings:['AUTH_TOKEN','OPENAI_API_KEY'],modelId:'gpt-5-mini',limits:{workerCpuMs:null,budgetCap:'none',accountUsage:'unknown'},billing:{plan:'fixture',changesSubscription:false,notice:'Offline fixture only; no resources created or billed'},tokenScopeVerified:false}; result=preview;
  } else if (r.op === 'deploy' && preview && r.confirmation.previewId === preview.id && r.confirmation.accountId === preview.account.id && r.confirmation.workerName === preview.workerName && r.confirmation.acceptResourceCreation === true && r.confirmation.acknowledgeUsageBilling === true && r.confirmation.approveSecretUpload === true && r.bootstrap.AUTH_TOKEN.length >= 43 && r.bootstrap.OPENAI_API_KEY.startsWith('sk-')) {
    result = {state:'deployed',accountId:preview.account.id,workerName:preview.workerName,endpoint:preview.endpoint,bundleSha256:preview.bundleSha256}; preview=undefined;
  }
  if (result) process.stdout.write(JSON.stringify({id:r.id,ok:true,result})+'\n');
  else process.stdout.write(JSON.stringify({id:r.id,ok:false,error:{code:'fixture_rejected',stage:'confirmation',writeState:'none',httpStatus:null,providerCodes:[]}})+'\n');
});
