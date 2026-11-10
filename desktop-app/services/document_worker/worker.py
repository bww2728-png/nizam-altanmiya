import json
import os
import socket
import sys
from contextlib import redirect_stdout
from pathlib import Path


def block_network(*args, **kwargs):
    raise RuntimeError("document processing is restricted to offline mode")


socket.socket.connect = block_network
socket.socket.connect_ex = block_network
socket.create_connection = block_network

SUPPORTED_DOCUMENTS = {".pdf", ".docx"}
SUPPORTED_IMAGES = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_ELEMENTS = 50000


def source_info(path: Path, page_number=None):
    result = {"file_name": path.name}
    if page_number is not None:
        result["page_number"] = page_number
    return result


def docling_extract(path: Path):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from docling.document_converter import DocumentConverter

    result = DocumentConverter().convert(str(path))
    document = result.document
    elements = []
    markdown = document.export_to_markdown()
    for index, item in enumerate(document.iterate_items()):
        if index >= MAX_ELEMENTS:
            raise ValueError("document element limit exceeded")
        node = item[0] if isinstance(item, tuple) else item
        label = getattr(node, "label", None)
        element_type = getattr(label, "name", None) or "text"
        text = getattr(node, "text", None) or ""
        if not text and hasattr(node, "export_to_markdown"):
            text = node.export_to_markdown()
        provenances = getattr(node, "prov", None) or []
        provenance = provenances[0] if provenances else None
        page_number = getattr(provenance, "page_no", None)
        bbox = getattr(provenance, "bbox", None)
        position = bbox.as_dict() if bbox is not None and hasattr(bbox, "as_dict") else None
        elements.append({
            "type": element_type,
            "content": str(text),
            "page_number": page_number,
            "position": position,
            "source": source_info(path, page_number),
        })
    return {
        "engine": {"name": "Docling", "version": _version("docling")},
        "structured": document.export_to_dict(),
        "markdown": markdown,
        "elements": elements,
        "warnings": [],
    }


def paddle_image_extract(path: Path):
    detector_value = os.environ.get("PADDLEOCR_DETECTION_MODEL_DIR", "")
    recognizer_value = os.environ.get("PADDLEOCR_RECOGNITION_MODEL_DIR", "")
    detector = Path(detector_value)
    recognizer = Path(recognizer_value)
    if not detector_value or not recognizer_value or not detector.is_dir() or not recognizer.is_dir():
        raise RuntimeError("offline Arabic PaddleOCR models are not configured locally")
    from paddleocr import PaddleOCR

    engine = PaddleOCR(
        lang="ar",
        text_detection_model_dir=str(detector),
        text_recognition_model_dir=str(recognizer),
    )
    output = engine.predict(str(path))
    elements = []
    raw_results = []
    for result in output:
        raw = result.json if hasattr(result, "json") else result
        if isinstance(raw, str):
            raw = json.loads(raw)
        raw_results.append(raw)
        values = raw.get("res", raw) if isinstance(raw, dict) else {}
        texts = values.get("rec_texts", [])
        scores = values.get("rec_scores", [])
        boxes = values.get("rec_polys", values.get("dt_polys", []))
        for index, text in enumerate(texts):
            confidence = scores[index] if index < len(scores) else None
            position = boxes[index] if index < len(boxes) else None
            elements.append({
                "type": "ocr-text",
                "content": str(text),
                "confidence": confidence,
                "position": position,
                "source": source_info(path),
            })
            if len(elements) > MAX_ELEMENTS:
                raise ValueError("OCR element limit exceeded")
    return {
        "engine": {"name": "PaddleOCR", "version": _version("paddleocr")},
        "structured": {"elements": elements},
        "markdown": "\n\n".join(element["content"] for element in elements),
        "ocr_json": json.dumps(raw_results, ensure_ascii=False),
        "elements": elements,
        "warnings": ["OCR confidence reflects recognition quality, not factual correctness."],
    }


def prepare_rows(payload):
    rows = payload.get("rows", [])
    if not isinstance(rows, list):
        raise ValueError("rows must be a list")
    if len(rows) > 100000:
        raise ValueError("row limit exceeded")
    try:
        import polars as pl

        frame = pl.DataFrame(rows, infer_schema_length=1000, strict=False)
        return {"engine": {"name": "Polars", "version": pl.__version__}, "rows": frame.to_dicts()}
    except ImportError:
        raise RuntimeError("Polars is not installed in the local document worker")


def _version(package):
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version(package)
    except PackageNotFoundError:
        return "unknown"


def process(payload):
    if payload.get("action") == "prepare_rows":
        return prepare_rows(payload)
    source = Path(payload.get("file_path", "")).resolve(strict=True)
    if not source.is_file() or source.stat().st_size <= 0 or source.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("invalid file or file size")
    suffix = source.suffix.lower()
    headers = source.read_bytes()[:8]
    if suffix == ".pdf" and not headers.startswith(b"%PDF-"):
        raise ValueError("PDF signature mismatch")
    if suffix == ".docx" and not headers.startswith(b"PK"):
        raise ValueError("DOCX signature mismatch")
    if suffix == ".png" and headers != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG signature mismatch")
    if suffix in {".jpg", ".jpeg"} and not headers.startswith(b"\xff\xd8\xff"):
        raise ValueError("JPEG signature mismatch")
    if suffix in {".tif", ".tiff"} and headers[:4] not in {b"II*\x00", b"MM\x00*"}:
        raise ValueError("TIFF signature mismatch")
    if suffix in SUPPORTED_IMAGES:
        return paddle_image_extract(source)
    if suffix in SUPPORTED_DOCUMENTS:
        return docling_extract(source)
    raise ValueError("unsupported document format; XLSX remains on the ExcelJS import path")


def main():
    try:
        payload = json.load(sys.stdin)
        with redirect_stdout(sys.stderr):
            result = process(payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))
        sys.stdout.flush()
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        sys.stderr.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
