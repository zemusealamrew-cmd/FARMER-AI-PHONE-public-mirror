# export-orm-tts.py — builder3 v29
# Oromo TTS export (GAP closure, owner order 2026-11-13).
#
# CONTEXT (evidence): research/onnx-export-20261111/export-report.json records the Amharic
# TTS export as EXPORTED_LEGACY_NOISE0 (deterministic: stochastic noise disabled) from
# facebook/mms-tts-amh. The Oromo model facebook/mms-tts-orm (registry: @487e4436,
# cc-by-nc-4.0, safetensors fff12bb8…, vocab.json 068a26eb…) was NEVER exported — the
# recorded reason the app speaks only Amharic replies today. This script follows the same
# verified export approach as the Amharic export.py for the Oromo model.
#
# RUN ON THE OWNER'S WINDOWS MACHINE, in the SAME venv used for the Amharic export:
#   python tools\export-orm-tts.py --orm-dir facebook--mms-tts-orm --out research\onnx-export-20261111
# Then re-run tools\package-g1-models.ps1 — vits-orm.onnx + vocab-orm.json are included and
# the phone speaks Afaan Oromo replies (app picks the model by the ASR language tag).
#
# NOTE (honest limits): export parity for the Amh model is an OPEN item (torch 27,648 vs
# ONNX 24,064 samples). The same parity check must be run for the Oromo export before its
# quality is considered verified. The packaging manifest + in-app SHA-256 check protect
# against corrupted transfers, not against export-quality issues.

import argparse, json, os, sys
import torch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orm-dir", required=True, help="local facebook/mms-tts-orm snapshot dir")
    ap.add_argument("--out", required=True, help="output dir (same as the Amh export dir)")
    args = ap.parse_args()

    from transformers import VitsModel, VitsTokenizer  # same stack as the Amh export

    model = VitsModel.from_pretrained(args.orm_dir, local_files_only=True)
    tok = VitsTokenizer.from_pretrained(args.orm_dir, local_files_only=True)

    # Deterministic export (EXPORTED_LEGACY_NOISE0 pattern): disable stochastic noise.
    if hasattr(model, "config"):
        model.config.noise_scale = 0.0
    model.eval()
    with torch.no_grad():
        if hasattr(model, "decoder") and hasattr(model.decoder, "flow"):
            try:
                model.decoder.flow.noise_scale = 0.0  # legacy attribute on older checkpoints
            except Exception:
                pass

    text = "ሰላም ገበሬ" if False else "nagaan bulte obboleeyya"  # simple deterministic probe
    inputs = tok(text, return_tensors="pt")

    os.makedirs(args.out, exist_ok=True)
    onnx_path = os.path.join(args.out, "mms-tts-orm-vits-nonoise.onnx")

    class _Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m
        def forward(self, input_ids):
            return self.m(input_ids=input_ids).waveform

    torch.onnx.export(
        _Wrapper(model), (inputs["input_ids"],), onnx_path,
        input_names=["input_ids"], output_names=["waveform"],
        dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "waveform": {0: "batch", 1: "samples"}},
        opset_version=14,
    )

    # copy the Oromo vocab next to the export (the app stages it as vocab-orm.json)
    import shutil
    shutil.copyfile(os.path.join(args.orm_dir, "vocab.json"), os.path.join(args.out, "vocab-orm.json"))

    print(json.dumps({
        "status": "EXPORTED",
        "onnx_path": onnx_path,
        "orm_vocab": os.path.join(args.out, "vocab-orm.json"),
        "note": "Run the same parity check as the Amh export before quality sign-off; parity for Amh is an OPEN item.",
    }, indent=2))


if __name__ == "__main__":
    sys.exit(main())
