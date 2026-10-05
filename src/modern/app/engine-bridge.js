/** Mandatory Design V2 engine boundary. No alternate calculation path is permitted. */
const DATA_URL = './data/viewer-data.json';
const toSharedRoute = { prompts:'prompts', answers:'behaviors', map:'atlas', models:'models', dataset:'distribution' };
const fromSharedRoute = { prompts:'prompts', behaviors:'answers', atlas:'map', models:'models', distribution:'dataset' };

export async function loadEngine() {
  let shared;
  try { shared = await import('../shared/index.js'); }
  catch (error) { throw new Error(`Could not load the shared analysis engine: ${error.message}`); }
  if (typeof shared.createEngine !== 'function' || typeof shared.encodeViewerState !== 'function' || typeof shared.decodeViewerState !== 'function')
    throw new Error('The shared analysis engine does not expose the required engine and state contracts.');
  const engine = await shared.createEngine({ dataUrl:DATA_URL, bundleUrl:'./viewer-bundle.json', buildUrl:'./viewer-build.json', expectedViewerVersion:__PREFSCOPE_VIEWER_VERSION__ });
  if (engine?.contractVersion !== 1) throw new Error('The shared analysis engine returned an unsupported contract.');
  const scope = shared.datasetScope(engine.dataset.payloadHash || DATA_URL);
  engine.state = {
    scope,
    encode(values) {
      const compact = { ...values, 'app.view':toSharedRoute[values.route] || 'prompts' };
      delete compact.route;
      for (const [cursorKey, rowKey] of [['promptCursor','promptRow'],['answerCursor','answerRow']]) {
        if (!compact[cursorKey]) continue;
        const row=engine.map.pointIndex.get(compact[cursorKey].row_id);
        if (Number.isInteger(row)) {
          compact[rowKey]=row;
          if(cursorKey==='answerCursor') compact.answerSide=compact[cursorKey].source===engine.observation(row,'pair')?.cursor.source?'pair':compact[cursorKey].source===engine.observation(row,'b')?.cursor.source?'b':'a';
        }
        delete compact[cursorKey];
      }
      return shared.encodeViewerState(compact, scope);
    },
    decode(hash) {
      const values=shared.decodeViewerState(hash, scope), route=fromSharedRoute[values['app.view']] || 'prompts';
      if (Number.isInteger(values.promptRow)) values.promptCursor=engine.observation(values.promptRow,'prompt')?.cursor ?? null;
      if (Number.isInteger(values.answerRow)) values.answerCursor=engine.observation(values.answerRow,values.answerSide==='pair'?'pair':values.answerSide==='b'?'b':'a')?.cursor ?? null;
      delete values['app.view'];delete values.promptRow;delete values.answerRow;delete values.answerSide;
      return { ...values, route };
    }
  };
  engine.modelAnalysisStatus = side => {
    const model=engine.models.find(item=>item.side===side),opponent=engine.models.find(item=>item.side!==side),distribution=engine.distributions(side);
    if(!model)return { compatibleSource:false,measuredAnswers:0,pairCount:0,scoredPairCount:0 };
    const pairRows=Array.from({length:engine.summary().canonicalRows},(_,row)=>engine.record(row)).filter(record=>record.modelA?.rawId&&record.modelB?.rawId&&record.modelA.rawId!==record.modelB.rawId&&[record.modelA.rawId,record.modelB.rawId].includes(model.rawId)&&(!opponent||[record.modelA.rawId,record.modelB.rawId].includes(opponent.rawId))),scoredPairCount=pairRows.filter(record=>Number.isFinite(side==='a'?record.preferenceA:record.preferenceB)).length;
    return { compatibleSource:distribution.length>0,measuredAnswers:Math.max(0,...distribution.map(row=>row.total||0)),pairCount:pairRows.length,scoredPairCount };
  };
  return Object.assign(engine, { source:'shared' });
}
