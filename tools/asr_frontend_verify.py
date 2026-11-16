#!/usr/bin/env python3
"""G1 ASR frontend verification (v26 repair, task-10).

Verifies that Android-produced SeamlessM4T features (float32 [frames,160], as written by
AsrFeatures.java / the desktop parity harness) are accepted by the pinned ASR ONNX model
and reproduce the committed ORT argmax reference + decode.

It also (optionally) compares the Java features against the ground-truth feature tensor
produced on the desktop by transformers 5.22.2 SeamlessM4TFeatureExtractor.

Usage:
  python tools/asr_frontend_verify.py \
    --onnx C:\g1repo\research\onnx-export-20261111\ethio-asr-wav2vec2bert.onnx \
    --features D:\g1repair\buildcheck\am-12.java.f32 --frames 822 \
    --gt-features C:\g1repo\.tmp\asr-quality-holdout-ascii\am-12.features.f32 \
    --argmax-ref research/asr-mem-options-20261112/argmax-ort-fp32-am-12.txt \
    --vocab C:\g1repo\app\models\badrex--Ethio-ASR-multilingual-600M\vocab.json \
    --out D:\g1repair\buildcheck\am-12.verify.json

Exit code 0 when the run completed; the JSON "ok" field is the strict verdict
(argmax frames 100% equal to reference AND decoded text identical to the reference decode).
"""
import argparse
import hashlib
import json
import os
import platform
import sys
import time

import numpy as np

BLANK_ID = 408
FEATURE_DIM = 160
DEFAULT_VOCAB_TAGS = ("[AMH]", "[ORM]")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_features(path: str, frames: int) -> np.ndarray:
    raw = np.fromfile(path, dtype="<f4")
    expected = frames * FEATURE_DIM
    if raw.size != expected:
        raise SystemExit(f"feature file {path}: {raw.size} floats, expected {expected} ({frames}x{FEATURE_DIM})")
    return raw.reshape(frames, FEATURE_DIM)


def load_argmax_ref(path: str) -> np.ndarray:
    tokens = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            tokens.extend(int(t) for t in line.split())
    return np.asarray(tokens, dtype=np.int64)


def ctc_collapse(ids: np.ndarray, blank: int = BLANK_ID):
    toks = []
    prev = blank
    for i in ids:
        i = int(i)
        if i == blank:
            prev = blank
            continue
        if i == prev:
            continue
        toks.append(i)
        prev = i
    return toks


def load_vocab(path: str):
    with open(path, "r", encoding="utf-8") as f:
        vocab = json.load(f)
    return {int(v): k for k, v in vocab.items()}


def decode_text(ids: np.ndarray, id_to_piece) -> dict:
    toks = ctc_collapse(ids)
    raw = "".join(id_to_piece.get(t, "\ufffd") for t in toks)
    with_sep = "".join(id_to_piece.get(t, "\ufffd").replace("|", " ") for t in toks)
    text = with_sep.strip()
    for tag in DEFAULT_VOCAB_TAGS:
        if text.startswith(tag):
            text = text[len(tag):].strip()
            break
    return {
        "ctc_tokens": len(toks),
        "text": text,
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "raw_joined_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        "first_tokens": toks[:24],
    }


def compare(frame_ids_a: np.ndarray, frame_ids_b: np.ndarray) -> dict:
    n = min(len(frame_ids_a), len(frame_ids_b))
    matching = int(np.sum(frame_ids_a[:n] == frame_ids_b[:n])) if n else 0
    first_div = None
    for i in range(n):
        if frame_ids_a[i] != frame_ids_b[i]:
            first_div = i
            break
    return {
        "frames_a": int(len(frame_ids_a)),
        "frames_b": int(len(frame_ids_b)),
        "compared": int(n),
        "matching": matching,
        "match_pct": (100.0 * matching / n) if n else 0.0,
        "first_divergence": first_div,
    }


def nonblank(ids: np.ndarray) -> dict:
    raw = int(np.sum(ids != BLANK_ID))
    collapsed = len(ctc_collapse(ids))
    return {"raw_nonblank": raw, "ctc_collapsed": collapsed}


def make_session(onnx_path: str, threads: int):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    t0 = time.time()
    sess = ort.InferenceSession(onnx_path, sess_options=so, providers=["CPUExecutionProvider"])
    load_ms = int((time.time() - t0) * 1000)
    input_meta = sess.get_inputs()[0]
    out_meta = sess.get_outputs()[0]
    meta = {
        "ort_version": ort.__version__,
        "onnx": onnx_path,
        "onnx_sha256": sha256_file(onnx_path),
        "input_name": input_meta.name,
        "input_shape": [str(d) for d in input_meta.shape],
        "output_name": out_meta.name,
        "session_load_ms": load_ms,
        "threads": threads,
    }
    return sess, meta


def run_features(sess, feats: np.ndarray):
    input_name = sess.get_inputs()[0].name
    output_name = sess.get_outputs()[0].name
    x = feats.reshape(1, feats.shape[0], FEATURE_DIM).astype(np.float32)
    t1 = time.time()
    logits = sess.run([output_name], {input_name: x})[0]
    run_ms = int((time.time() - t1) * 1000)
    argmax = np.argmax(logits, axis=-1).reshape(-1).astype(np.int64)
    return argmax, run_ms, [int(d) for d in logits.shape]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Verify Android ASR features against the pinned ONNX model and ORT argmax reference")
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--features", required=True, help="float32 [frames,160] produced by AsrFeatures (Java)")
    ap.add_argument("--frames", required=True, type=int)
    ap.add_argument("--gt-features", default=None, help="optional ground-truth features (transformers) for numeric diff")
    ap.add_argument("--argmax-ref", required=True, help="committed argmax reference (space-separated token ids)")
    ap.add_argument("--vocab", required=True, help="ASR vocab.json ({piece: id})")
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--skip-gt-ort", action="store_true", help="do not run the GT features through ORT (only numeric diff)")
    args = ap.parse_args(argv)

    feats = load_features(args.features, args.frames)
    ref = load_argmax_ref(args.argmax_ref)
    id_to_piece = load_vocab(args.vocab)

    result = {
        "tool": "asr_frontend_verify",
        "schema": "g1-asr-frontend-verify/1",
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": {"platform": platform.platform(), "python": platform.python_version(), "numpy": np.__version__},
        "features": {
            "path": args.features,
            "frames": int(feats.shape[0]),
            "dim": int(feats.shape[1]),
            "float_count": int(feats.size),
            "sha256": sha256_file(args.features),
            "dtype": "float32-le",
            "range": [float(feats.min()), float(feats.max())],
        },
        "argmax_ref": {
            "path": args.argmax_ref,
            "frames": int(ref.size),
            "sha256": sha256_file(args.argmax_ref),
            "nonblank": nonblank(ref),
            "decode": decode_text(ref, id_to_piece),
        },
    }

    if args.gt_features:
        gt = load_features(args.gt_features, args.frames)
        diff = np.abs(feats.astype(np.float64) - gt.astype(np.float64))
        result["gt_features"] = {
            "path": args.gt_features,
            "frames": int(gt.shape[0]),
            "dim": int(gt.shape[1]),
            "sha256": sha256_file(args.gt_features),
            "max_abs_diff": float(diff.max()),
            "mean_abs_diff": float(diff.mean()),
            "p99_abs_diff": float(np.percentile(diff, 99)),
            "exact_equal_floats": int(np.sum(feats == gt)),
            "float_count": int(gt.size),
        }

    sess, ort_meta = make_session(args.onnx, args.threads)
    java_argmax, run_ms, out_shape = run_features(sess, feats)
    ort_meta["output_shape"] = out_shape
    ort_meta["frames"] = out_shape[1]
    ort_meta["vocab"] = out_shape[2]
    ort_meta["run_ms"] = run_ms
    result["ort"] = ort_meta
    result["argmax_java"] = {
        "frames": int(java_argmax.size),
        "nonblank": nonblank(java_argmax),
        "decode": decode_text(java_argmax, id_to_piece),
        "vs_ref": compare(java_argmax, ref),
    }
    result["decode_matches_ref"] = (
        result["argmax_java"]["decode"]["text_sha256"] == result["argmax_ref"]["decode"]["text_sha256"]
    )

    if args.gt_features and not args.skip_gt_ort:
        gt = load_features(args.gt_features, args.frames)
        gt_argmax, gt_run_ms, gt_out_shape = run_features(sess, gt)
        result["argmax_gt"] = {
            "frames": int(gt_argmax.size),
            "nonblank": nonblank(gt_argmax),
            "decode": decode_text(gt_argmax, id_to_piece),
            "vs_ref": compare(gt_argmax, ref),
            "ort": {"run_ms": gt_run_ms, "output_shape": gt_out_shape},
        }

    result["ok"] = (
        result["argmax_java"]["vs_ref"]["match_pct"] == 100.0
        and result["decode_matches_ref"]
    )
    if "gt_features" in result:
        result["frontend_parity_ok"] = result["gt_features"]["max_abs_diff"] <= 1e-3

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print("features:", result["features"]["frames"], "x", result["features"]["dim"], "sha256", result["features"]["sha256"][:16])
    if "gt_features" in result:
        g = result["gt_features"]
        print("gt diff: max_abs_diff=%.3e mean_abs_diff=%.3e exact_equal=%d/%d"
              % (g["max_abs_diff"], g["mean_abs_diff"], g["exact_equal_floats"], g["float_count"]))
    print("ort: %s in=%s out=%s frames=%d vocab=%d load=%dms run=%dms"
          % (result["ort"]["ort_version"], result["ort"]["input_shape"], result["ort"]["output_shape"],
             result["ort"]["frames"], result["ort"]["vocab"], result["ort"]["session_load_ms"], result["ort"]["run_ms"]))
    for key in ("argmax_java", "argmax_gt"):
        if key in result:
            v = result[key]["vs_ref"]
            print("%s vs ref: matching=%d/%d (%.3f%%) first_div=%s"
                  % (key, v["matching"], v["compared"], v["match_pct"], v["first_divergence"]))
            print("  decode:", result[key]["decode"]["text"][:120])
    print("decode_matches_ref:", result["decode_matches_ref"], " ok:", result["ok"],
          " frontend_parity_ok:", result.get("frontend_parity_ok"))
    # always exit 0 when the verification RAN; the JSON carries the strict verdict
    return 0


if __name__ == "__main__":
    sys.exit(main())
