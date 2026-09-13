import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticFactsAgree,safeSemanticCandidate,selectedSentence,importantCategory,explicitRestart} from '../src/features/local-ai/semantic-policy.ts';
test('semantic model cannot override changed amounts, names, polarity, or missing facts',()=>{
 for(const [a,b]of [['It costs fifty dollars.','It costs fifteen dollars.'],['Meet Sarah tomorrow.','Meet James tomorrow.'],['The camera records in four K.','The camera does not record in four K.'],['The battery lasts ten hours.','The battery lasts hours.'],['Sarah leads the team.','James leads the team.'],['Delivery is not free.','You do not pay for shipping.']]) assert.equal(semanticFactsAgree(a,b),false,`${a} / ${b}`);
});
test('ordinary cost and delivery paraphrases preserve facts',()=>{
 for(const [a,b]of [['Delivery is free.','You do not pay for shipping.'],['The package arrives tomorrow.','Your parcel will be delivered the next day.'],['Save your changes before closing the app.','Before you exit, remember to save your work.'],['It costs fifty dollars.','It costs 50 dollars.']]) assert.equal(safeSemanticCandidate(a,b),true,`${a} / ${b}`);
});
test('unrelated speech does not become a matching line because a model chooses a number',()=>assert.equal(safeSemanticCandidate('We record beautiful videos.','Bananas taste delicious.'),false));
test('model output needs an unambiguous in-range leading choice',()=>{
 assert.equal(selectedSentence('The best answer is **3. The package arrives tomorrow.**',4),2);
 for(const result of ['5. None of these sentences.','1, 2, or 3.','The answer could be anything','8. Example']) assert.equal(selectedSentence(result,4),null,result);
});
test('importance treats CTA facts as important and excludes greetings',()=>{
 assert.equal(importantCategory('This sentence is a **fact**.'),true);
 assert.equal(importantCategory('The sentence is a greeting.'),false);
 assert.equal(importantCategory('Unknown.'),null);
});
test('fumble signal requires explicit restart speech',()=>{
 assert.equal(explicitRestart('Delivery is fr sorry let me start again.'),true);
 assert.equal(explicitRestart('Sorry about the delay. Delivery is free.'),false);
 assert.equal(explicitRestart('Delivery is free.'),false);
});

test('normalizing instruction order preserves before versus after',()=>{
 assert.equal(safeSemanticCandidate('Save your changes before closing the app.','After you exit, save your work.'),false);
 assert.equal(safeSemanticCandidate('The package arrives tomorrow.','Your parcel will be delivered yesterday.'),false);
 assert.equal(safeSemanticCandidate('Delivery is not free.','Shipping has no charge.'),false);
});
