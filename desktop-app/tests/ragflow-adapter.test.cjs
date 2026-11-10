'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RagflowAdapter, localOrigin } = require('../src/main/documents/ragflow-adapter.cjs');

const datasetId = 'a'.repeat(32);
const documentId = 'b'.repeat(32);

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('RAGFlow origin is restricted to the configured loopback service', () => {
  assert.equal(localOrigin(), 'http://127.0.0.1:9380');
  for (const origin of [
    'https://127.0.0.1:9380',
    'http://localhost:9380',
    'http://127.0.0.1:9390',
    'http://user:secret@127.0.0.1:9380',
    'http://192.168.1.5:9380',
  ]) assert.throws(() => localOrigin(origin));
});

test('retrieval returns cited source chunks and never generates an answer', async () => {
  const requests = [];
  const adapter = new RagflowAdapter({
    apiKey: 'local-test-key',
    datasetIds: [datasetId],
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse({ data: { chunks: [{
        content: 'مقتطف موثق',
        document_id: documentId,
        docnm_kwd: 'تقرير.pdf',
        dataset_id: datasetId,
        positions: [{ page: 2 }],
        similarity: 0.91,
        document_metadata: { directorate_id: 'district-1' },
      }] } });
    },
  });

  const result = await adapter.retrieve({
    question: 'مشاريع المياه في المديرية',
    limit: 4,
    filters: { directorate_id: 'district-1', unsupported: 'ignored' },
  });

  assert.equal(result.resultType, 'retrieved-evidence');
  assert.equal(result.generatedAnswer, null);
  assert.equal(result.rows[0].content, 'مقتطف موثق');
  assert.equal(result.rows[0].documentId, documentId);
  assert.equal(result.rows[0].metadata.directorate_id, 'district-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:9380/api/v1/retrieval');
  assert.deepEqual(JSON.parse(requests[0].options.body).dataset_ids, [datasetId]);
  assert.equal(JSON.parse(requests[0].options.body).metadata_condition.conditions.length, 1);
});

test('document indexing uploads once, starts chunk processing and polls status', async () => {
  const requests = [];
  const transitions = [];
  const adapter = new RagflowAdapter({
    apiKey: 'local-test-key',
    datasetIds: [datasetId],
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/documents') && options.method === 'POST') return jsonResponse({ data: { docs: [{ id: documentId }] } });
      if (String(url).endsWith('/chunks')) return jsonResponse({ code: 0, data: {} });
      if (String(url).includes('/documents?')) return jsonResponse({ data: { docs: [{ id: documentId, run: 'DONE' }] } });
      throw new Error(`Unexpected RAGFlow request: ${url}`);
    },
  });

  const indexed = await adapter.indexDocument({
    id: 'local-document-1',
    file_name: 'report.pdf',
    mime_type: 'application/pdf',
    content: Buffer.from('%PDF-1.7'),
  }, { onReference: reference => transitions.push(reference) });
  const status = await adapter.documentStatus(datasetId, documentId);

  assert.deepEqual(indexed.results, [{ datasetId, ragflowDocumentId: documentId, status: 'processing' }]);
  assert.deepEqual(transitions.map(reference => reference.status), ['uploaded', 'processing']);
  assert.equal(status.status, 'indexed');
  assert.equal(requests.length, 3);
  assert.ok(requests[0].options.body instanceof FormData);
  assert.deepEqual(JSON.parse(requests[1].options.body).document_ids, [documentId]);
});

test('indexing is idempotent while an existing reference is processing or indexed', async () => {
  let callCount = 0;
  const adapter = new RagflowAdapter({
    apiKey: 'local-test-key',
    datasetIds: [datasetId],
    fetch: async () => { callCount += 1; return jsonResponse({ data: {} }); },
  });

  const result = await adapter.indexDocument({ id: 'local-document-1', content: Buffer.from('x') }, {
    references: [{ dataset_id: datasetId, ragflow_document_id: documentId, status: 'processing' }],
  });

  assert.equal(callCount, 0);
  assert.deepEqual(result.results, [{ datasetId, ragflowDocumentId: documentId, status: 'processing' }]);
});
