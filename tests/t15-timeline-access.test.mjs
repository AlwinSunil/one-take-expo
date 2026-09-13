import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineDevelopmentAccess } from '../src/features/timeline/access.ts';
test('timeline development access is off in production and requires exact opt-in', () => {
  assert.equal(timelineDevelopmentAccess(true,'1'),true);
  for (const request of [undefined,null,false,true,'0','true',['1']]) assert.equal(timelineDevelopmentAccess(true,request),false);
  assert.equal(timelineDevelopmentAccess(false,'1'),false);
});
