import test from 'node:test';
import assert from 'node:assert/strict';
import {previewUploadMetadata, previewDeployment} from './preview-upload-metadata.mjs';
const settings={bindings:[{name:'ENGINE',type:'durable_object_namespace',namespace_id:'2b98d86119194b17a791a5128375533d'},{name:'STATE',type:'r2_bucket',bucket_name:'gateway-preview-state'},{name:'MANAGEMENT_KEY',type:'secret_text'},{name:'CONTAINER_IDLE_TIMEOUT_MS',type:'plain_text',text:'30000'}]};
test('code-only upload retains container linkage and existing bindings without secret values',()=>{const m=previewUploadMetadata(settings,'a'.repeat(40));assert.deepEqual(m.containers,[{class_name:'Engine'}]);assert.deepEqual(m.keep_bindings,['secret_text']);assert.equal(m.bindings.find(b=>b.name==='CONTAINER_IDLE_TIMEOUT_MS').text,'30000');assert.equal(m.bindings.some(b=>b.name==='MANAGEMENT_KEY'),false);assert.equal(m.bindings.find(b=>b.name==='AI').type,'ai');});
test('cannot target production or foreign storage',()=>{assert.throws(()=>previewUploadMetadata({bindings:[]},'a'.repeat(40)));});

test("deployment and rollback explicitly refresh Durable Object code",()=>{assert.deepEqual(previewDeployment("7059fc14-f9ac-4c31-8320-17822be183cd").code_update_strategy,{mode:"immediate"});assert.throws(()=>previewDeployment("bad"));});
