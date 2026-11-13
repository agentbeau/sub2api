// Stage through versions POST only; never auto-deploy a raw script PUT.
// Worker-code-only uploads must retain native container capability.
// Container image/application rollout remains outside this helper.
import assert from 'node:assert/strict';
export function previewUploadMetadata(settings, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.ok(settings.bindings.some(b => b.name === 'ENGINE' && b.type === 'durable_object_namespace' && b.namespace_id === '2b98d86119194b17a791a5128375533d'));
  assert.ok(settings.bindings.some(b => b.name === 'STATE' && b.bucket_name === 'gateway-preview-state'));
  const bindings = settings.bindings.filter(b => b.type !== 'secret_text' && b.name !== 'AI' && b.name !== 'CLEF_ENABLED');
  bindings.push({name:'AI',type:'ai'},{name:'CLEF_ENABLED',type:'plain_text',text:'true'});
  return {main_module:'preview.js',containers:[{class_name:'Engine'}],bindings,keep_bindings:['secret_text'],compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags,usage_model:settings.usage_model,tags:settings.tags,tail_consumers:settings.tail_consumers,logpush:settings.logpush,annotations:{'workers/message':`Enhanced Clef source ${revision}; retain Engine linkage and image`}};
}

// Use only after confirming no active work; applies equally to rollback.
export function previewDeployment(version) {
  assert.match(version, /^[0-9a-f-]{36}$/);
  return {strategy:"percentage",versions:[{version_id:version,percentage:100}],code_update_strategy:{mode:"immediate"}};
}
