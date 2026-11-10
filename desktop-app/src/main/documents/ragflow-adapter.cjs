'use strict';

const DEFAULT_ORIGIN = 'http://127.0.0.1:9380';
const MAX_QUERY_LENGTH = 500;
const FILTER_KEYS = new Set(['governorate_id', 'directorate_id', 'sector_id', 'reference_period', 'source_type']);

function localOrigin(value = DEFAULT_ORIGIN) {
  let url;
  try { url = new URL(value); } catch { throw new Error('عنوان خدمة البحث المحلي غير صالح.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '9380' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('يسمح بالبحث فقط عبر RAGFlow المحلي على 127.0.0.1:9380.');
  }
  return url.origin;
}

function normalizeFilters(input = {}) {
  const conditions = [];
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!FILTER_KEYS.has(name) || typeof value !== 'string' || !value.trim()) continue;
    conditions.push({ name, comparison_operator: '=', value: value.trim().slice(0, 120) });
  }
  return conditions.length ? { logic: 'and', conditions } : null;
}

class RagflowAdapter {
  constructor(options = {}) {
    this.origin = localOrigin(options.origin ?? process.env.RAGFLOW_LOCAL_ORIGIN ?? DEFAULT_ORIGIN);
    this.apiKey = String(options.apiKey ?? process.env.RAGFLOW_API_KEY ?? '').trim();
    this.datasetIds = [...new Set((options.datasetIds ?? process.env.RAGFLOW_DATASET_IDS ?? '').toString().split(',').map((value) => value.trim()).filter((value) => /^[a-f0-9]{32}$/i.test(value)))];
    this.fetch = options.fetch;
  }

  status() {
    return {
      configured: Boolean(this.apiKey && this.datasetIds.length),
      origin: this.origin,
      datasetCount: this.datasetIds.length,
      generation: 'disabled',
      message: this.apiKey && this.datasetIds.length
        ? 'البحث المحلي مهيأ؛ يعرض المقاطع ومراجعها دون توليد إجابات أو استخدام نموذج لغوي.'
        : 'خدمة البحث المعرفي المحلية غير مهيأة. لا تُرسل الوثائق خارج الجهاز.',
    };
  }

  async request(path, options = {}) {
    if (typeof this.fetch !== 'function') throw new Error('وسيلة الاتصال المحلية غير متاحة.');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('رُفض عنوان خدمة خارجية.');
    const headers = {
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    };
    const response = await this.fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body ? { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response?.ok) throw new Error(`خدمة RAGFlow المحلية أعادت HTTP ${response?.status ?? 'unknown'}.`);
    const payload = await response.json();
    if (payload && typeof payload === 'object' && payload.code !== undefined && Number(payload.code) !== 0) {
      throw new Error(`تعذر تنفيذ البحث المحلي (رمز الخدمة ${String(payload.code).slice(0, 20)}).`);
    }
    return payload;
  }

  async health() {
    try {
      await this.request('/api/v1/system/healthz');
      return { ...this.status(), available: true };
    } catch (error) {
      return { ...this.status(), available: false, error: String(error?.message ?? error).slice(0, 500) };
    }
  }

  async indexDocument(document, options = {}) {
    if (!this.apiKey || !this.datasetIds.length) throw new Error('لم تُهيأ خدمة RAGFlow المحلية ومجموعة المستندات.');
    if (!document || !Buffer.isBuffer(document.content) || document.content.length > 50 * 1024 * 1024) {
      throw new Error('محتوى الوثيقة المراد فهرستها غير صالح أو يتجاوز الحد الآمن.');
    }
    const previous = new Map((options.references ?? []).map((reference) => [reference.dataset_id, reference]));
    const indexed = [];
    for (const datasetId of this.datasetIds) {
      const reference = previous.get(datasetId);
      if (reference?.status === 'indexed' || reference?.status === 'processing') {
        indexed.push({ datasetId, ragflowDocumentId: reference.ragflow_document_id, status: reference.status });
        continue;
      }
      let ragflowDocumentId = reference?.ragflow_document_id ?? '';
      if (!ragflowDocumentId) {
        const form = new FormData();
        form.append('file', new Blob([document.content], { type: document.mime_type }), document.file_name);
        const payload = await this.request(`/api/v1/datasets/${datasetId}/documents`, { method: 'POST', body: form });
        const entries = payload?.data?.docs ?? payload?.data;
        const uploaded = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? [entries] : [];
        const record = uploaded.find((item) => typeof item?.id === 'string' || typeof item?._id === 'string');
        ragflowDocumentId = String(record?.id ?? record?._id ?? '');
        if (!/^[a-f0-9]{32}$/i.test(ragflowDocumentId)) throw new Error('لم تُرجع خدمة RAGFlow معرف وثيقة صالحًا.');
        options.onReference?.({ dataset_id: datasetId, ragflow_document_id: ragflowDocumentId, status: 'uploaded' });
      }
      try {
        await this.request(`/api/v1/datasets/${datasetId}/chunks`, {
          method: 'POST',
          body: { document_ids: [ragflowDocumentId] },
        });
        options.onReference?.({ dataset_id: datasetId, ragflow_document_id: ragflowDocumentId, status: 'processing' });
        indexed.push({ datasetId, ragflowDocumentId, status: 'processing' });
      } catch (error) {
        options.onReference?.({ dataset_id: datasetId, ragflow_document_id: ragflowDocumentId, status: 'failed' });
        throw error;
      }
    }
    return { documentId: document.id, results: indexed };
  }

  async documentStatus(datasetId, documentId) {
    if (!this.apiKey || !this.datasetIds.includes(datasetId) || !/^[a-f0-9]{32}$/i.test(String(documentId))) {
      throw new Error('مرجع وثيقة أو مجموعة RAGFlow غير صالح.');
    }
    const query = new URLSearchParams({ id: String(documentId), page: '1', page_size: '1' });
    const payload = await this.request(`/api/v1/datasets/${datasetId}/documents?${query}`);
    const documents = payload?.data?.docs ?? [];
    const item = Array.isArray(documents) ? documents.find((row) => String(row.id ?? row._id ?? '') === String(documentId)) : null;
    const run = String(item?.run ?? '').toUpperCase();
    const status = run === 'DONE' ? 'indexed' : run === 'FAIL' || run === 'FAILED' ? 'failed' : 'processing';
    return { datasetId, documentId, status, run: run.slice(0, 40) };
  }

  async retrieve(request = {}) {
    if (!this.apiKey || !this.datasetIds.length) throw new Error('لم تُهيأ خدمة RAGFlow المحلية ومجموعة المستندات.');
    const question = String(request.question ?? '').trim();
    if (question.length < 2 || question.length > MAX_QUERY_LENGTH) throw new Error('يجب أن يتراوح سؤال البحث بين حرفين و500 حرف.');
    const body = {
      question,
      dataset_ids: this.datasetIds,
      page: 1,
      page_size: Math.max(1, Math.min(20, Math.trunc(Number(request.limit) || 10))),
      keywords_similarity_weight: 0.5,
      highlight: false,
      include_knowledge_compilation: false,
    };
    const conditions = normalizeFilters(request.filters);
    if (conditions) body.metadata_condition = conditions;
    const payload = await this.request('/api/v1/retrieval', { method: 'POST', body });
    const data = payload?.data ?? {};
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const rows = chunks.map((chunk) => ({
      content: String(chunk.content ?? ''),
      documentId: String(chunk.document_id ?? ''),
      documentName: String(chunk.docnm_kwd ?? ''),
      datasetId: String(chunk.dataset_id ?? ''),
      positions: Array.isArray(chunk.positions) ? chunk.positions : [],
      similarity: Number.isFinite(Number(chunk.similarity)) ? Number(chunk.similarity) : null,
      metadata: chunk.document_metadata && typeof chunk.document_metadata === 'object' ? chunk.document_metadata : {},
    })).filter((chunk) => chunk.content && chunk.documentId && chunk.documentName);
    return { question, resultType: 'retrieved-evidence', generatedAnswer: null, rows };
  }
}

module.exports = { DEFAULT_ORIGIN, FILTER_KEYS, localOrigin, normalizeFilters, RagflowAdapter };
