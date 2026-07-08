"""Proxima — OCR Module.
Provides utility functions to read screen text and search for screen text coordinates.
"""
import os
import sys
import platform


def _import_pyautogui():
    """Attempts to import pyautogui safely."""
    try:
        import pyautogui
        return pyautogui, None
    except Exception as e:
        return None, f"pyautogui unavailable: {e}"


def _no_screen_result(error):
    """Returns empty screen capture layout result."""
    return {
        "text": f"[Screen capture unavailable. {error}]",
        "blocks": [],
        "engine": "none",
        "word_count": 0,
        "error": error,
    }


def read_screen(save_path=None):
    """Captures screen and extracts text using OCR."""
    pyautogui, err = _import_pyautogui()
    if pyautogui is None:
        return _no_screen_result(err)

    screenshot = pyautogui.screenshot()
    if save_path:
        screenshot.save(save_path)
    
    return _ocr_image(screenshot)


def read_region(x, y, width, height, save_path=None):
    """Captures region and extracts text using OCR."""
    pyautogui, err = _import_pyautogui()
    if pyautogui is None:
        return _no_screen_result(err)

    screenshot = pyautogui.screenshot(region=(x, y, width, height))
    if save_path:
        screenshot.save(save_path)
    
    return _ocr_image(screenshot)


def read_image(image_path):
    """Extracts text from an image file using OCR."""
    try:
        from PIL import Image
        img = Image.open(image_path)
    except Exception as e:
        return _no_screen_result(f"cannot open image '{image_path}': {e}")
    return _ocr_image(img)


def find_text_on_screen(target_text, threshold=0.7):
    """Locates coordinates of target text on screen."""
    pyautogui, err = _import_pyautogui()
    if pyautogui is None:
        print(f"[OCR] {err}")
        return []

    screenshot = pyautogui.screenshot()
    result = _ocr_image(screenshot)
    
    matches = []
    target_lower = target_text.lower()
    
    for block in result.get("blocks", []):
        if target_lower in block.get("text", "").lower() and block.get("confidence", 0) >= threshold:
            x, y, w, h = block["x"], block["y"], block["width"], block["height"]
            if w <= 0 or h <= 0:
                continue
            matches.append({
                "text": block["text"],
                "x": x,
                "y": y,
                "width": w,
                "height": h,
                "center_x": x + w // 2,
                "center_y": y + h // 2,
                "confidence": block.get("confidence", 0),
            })
    
    return matches


def click_text(target_text, confidence=0.7):
    """Clicks the center of target text found on screen."""
    pyautogui, err = _import_pyautogui()
    if pyautogui is None:
        print(f"[OCR] {err}")
        return None

    matches = find_text_on_screen(target_text, threshold=confidence)
    if not matches:
        print(f"Text '{target_text}' not found on screen")
        return None
    
    match = matches[0]
    pyautogui.click(match["center_x"], match["center_y"])
    print(f"Clicked '{match['text']}' at ({match['center_x']}, {match['center_y']})")
    return match


def _ocr_image(image):
    """Extracts text from a PIL image using available OCR engines."""
    try:
        import pytesseract
        
        if platform.system() == "Windows":
            default_paths = [
                r"C:\Program Files\Tesseract-OCR\tesseract.exe",
                r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
                os.path.expandvars(r"%LocalAppData%\Programs\Tesseract-OCR\tesseract.exe"),
            ]
            for p in default_paths:
                if os.path.exists(p):
                    pytesseract.pytesseract.tesseract_cmd = p
                    break
        
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
        full_text = pytesseract.image_to_string(image).strip()
        
        blocks = []
        n = len(data["text"])
        for i in range(n):
            text = data["text"][i].strip()
            try:
                conf = int(float(data["conf"][i]))
            except (ValueError, TypeError):
                continue
            if text and conf > 0:
                blocks.append({
                    "text": text,
                    "x": data["left"][i],
                    "y": data["top"][i],
                    "width": data["width"][i],
                    "height": data["height"][i],
                    "confidence": conf / 100.0,
                    "line": data["line_num"][i],
                    "block": data["block_num"][i],
                })
        
        return {
            "text": full_text,
            "blocks": blocks,
            "engine": "tesseract",
            "word_count": len([b for b in blocks if b["confidence"] > 0.5]),
        }
    
    except Exception as e:
        tesseract_error = str(e)
    
    if platform.system() == "Windows":
        try:
            return _windows_native_ocr(image)
        except Exception:
            pass
    elif platform.system() == "Darwin":
        try:
            return _macos_native_ocr(image)
        except Exception:
            pass
    
    install_hint = "https://github.com/tesseract-ocr/tesseract/releases"
    if platform.system() == "Darwin":
        install_hint = "brew install tesseract"
    elif platform.system() == "Linux":
        install_hint = "sudo apt install tesseract-ocr"
    
    return {
        "text": f"[OCR unavailable. Install Tesseract: {install_hint}]\n[Error: {tesseract_error}]",
        "blocks": [],
        "engine": "none",
        "word_count": 0,
        "error": tesseract_error,
    }


def _windows_native_ocr(image):
    """Extracts text using Windows native OCR API."""
    import subprocess
    import tempfile
    import json as json_mod
    
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    image.save(tmp.name)
    tmp.close()
    
    try:
        ps_script = '''
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]

$file = [Windows.Storage.StorageFile]::GetFileFromPathAsync($env:PROXIMA_OCR_PATH).GetAwaiter().GetResult()
$stream = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read).GetAwaiter().GetResult()
$decoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream).GetAwaiter().GetResult()
$bitmap = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult()

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = $engine.RecognizeAsync($bitmap).GetAwaiter().GetResult()

$words = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
  foreach ($w in $line.Words) {
    $r = $w.BoundingRect
    [void]$words.Add([PSCustomObject]@{
      text = $w.Text
      x = [int][math]::Round($r.X)
      y = [int][math]::Round($r.Y)
      w = [int][math]::Round($r.Width)
      h = [int][math]::Round($r.Height)
    })
  }
}
[PSCustomObject]@{ text = $result.Text; words = $words } | ConvertTo-Json -Compress -Depth 4
'''
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "PROXIMA_OCR_PATH": tmp.name},
        )

        raw = result.stdout.strip()
        full_text = raw
        blocks = []
        try:
            data = json_mod.loads(raw)
            full_text = (data.get("text") or "").strip()
            words = data.get("words") or []
            if isinstance(words, dict):
                words = [words]
            for w in words:
                try:
                    bw, bh = int(w.get("w", 0)), int(w.get("h", 0))
                    blocks.append({
                        "text": w.get("text", ""),
                        "x": int(w.get("x", 0)),
                        "y": int(w.get("y", 0)),
                        "width": bw,
                        "height": bh,
                        "confidence": 0.8,
                    })
                except Exception:
                    continue
        except Exception:
            blocks = [
                {"text": line, "x": 0, "y": 0, "width": 0, "height": 0, "confidence": 0.8}
                for line in full_text.split("\n") if line.strip()
            ]

        return {
            "text": full_text,
            "blocks": blocks,
            "engine": "windows_native",
            "word_count": len(blocks),
        }
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def _macos_native_ocr(image):
    """Extracts text using macOS Vision framework."""
    import subprocess
    import tempfile

    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    image.save(tmp.name)
    tmp.close()

    try:
        swift_script = '''
use framework "Vision"
use framework "AppKit"
use framework "Foundation"

set imagePath to (current application's NSProcessInfo's processInfo()'s environment()'s objectForKey:"PROXIMA_OCR_PATH") as text
set theURL to current application's NSURL's fileURLWithPath:imagePath
set theImage to current application's NSImage's alloc()'s initWithContentsOfURL:theURL
set theCIImage to current application's CIImage's imageWithData:(theImage's TIFFRepresentation())

set theRequest to current application's VNRecognizeTextRequest's alloc()'s init()
theRequest's setRecognitionLevel:(current application's VNRequestTextRecognitionLevelAccurate)

set theHandler to current application's VNImageRequestHandler's alloc()'s initWithCIImage:theCIImage options:(current application's NSDictionary's dictionary())
theHandler's performRequests:{theRequest} |error|:(missing value)

set theResults to theRequest's results()
set outputText to ""
repeat with obs in theResults
    set outputText to outputText & (obs's topCandidates:1)'s firstObject()'s |string|() & linefeed
end repeat
return outputText
'''
        result = subprocess.run(
            ["osascript", "-l", "AppleScript", "-e", swift_script],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "PROXIMA_OCR_PATH": tmp.name},
        )

        text = result.stdout.strip()
        if text:
            return {
                "text": text,
                "blocks": [{"text": line, "x": 0, "y": 0, "width": 0, "height": 0, "confidence": 0.9}
                           for line in text.split("\n") if line.strip()],
                "engine": "macos_vision",
                "word_count": len(text.split()),
            }
        raise RuntimeError("Vision OCR returned empty result")
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
