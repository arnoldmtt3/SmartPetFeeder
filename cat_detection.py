"""Cat-only MobileNet-SSD inference and conservative temporal presence state."""
import math
from pathlib import Path


class PresenceTracker:
    def __init__(self, threshold=3.0, departure_delay=3.0, stale_after=4.0):
        self.threshold = float(threshold)
        self.departure_delay = float(departure_delay)
        self.stale_after = float(stale_after)
        self.reset()

    def reset(self):
        self.first_seen = None
        self.last_seen = None
        self.last_sample = None
        self.confirmed = False

    def update(self, detected, now):
        if self.last_sample is not None and now - self.last_sample > self.stale_after:
            self.reset()
        self.last_sample = now
        if detected:
            if self.last_seen is None or now - self.last_seen > self.departure_delay:
                self.first_seen = now
            self.last_seen = now
            self.confirmed = self.confirmed or now - self.first_seen >= self.threshold
        elif self.last_seen is None or now - self.last_seen >= self.departure_delay:
            self.first_seen = None
            self.last_seen = None
            self.confirmed = False

    def status(self, now):
        stale = self.last_sample is None or now - self.last_sample > self.stale_after
        elapsed = 0 if self.first_seen is None or self.last_seen is None else max(0, self.last_seen - self.first_seen)
        return {'presence_confirmed': self.confirmed and not stale,
                'presence_seconds': round(elapsed, 1), 'stale': stale}


class CatDetector:
    # VOC label order: cat=8, not the COCO class index.
    CAT_CLASS = 8

    def __init__(self, model_dir=None, confidence=0.65):
        self.model_dir = Path(model_dir or Path(__file__).with_name('models'))
        self.confidence = float(confidence)
        self.net = None

    def load(self):
        import cv2
        config = self.model_dir / 'deploy.prototxt'
        weights = self.model_dir / 'mobilenet_iter_73000.caffemodel'
        if not config.is_file() or not weights.is_file():
            raise RuntimeError('Falta el modelo en models; no se usará movimiento como reemplazo.')
        self.net = cv2.dnn.readNetFromCaffe(str(config), str(weights))
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)

    def detect(self, frame):
        import cv2
        if self.net is None:
            self.load()
        self.net.setInput(cv2.dnn.blobFromImage(frame, 0.007843, (300, 300), 127.5, swapRB=False, crop=False))
        output = self.net.forward()
        height, width = frame.shape[:2]
        boxes = []
        for item in output.reshape(-1, 7):
            confidence = float(item[2])
            if not math.isfinite(confidence) or not math.isfinite(float(item[1])) or int(item[1]) != self.CAT_CLASS or confidence < self.confidence:
                continue
            coords = [float(v) for v in item[3:7]]
            if not all(math.isfinite(v) for v in coords):
                continue
            x1, y1, x2, y2 = coords
            box = [int(max(0, min(width-1, x1*width))), int(max(0, min(height-1, y1*height))),
                   int(max(0, min(width-1, x2*width))), int(max(0, min(height-1, y2*height)))]
            if box[2] > box[0] and box[3] > box[1]:
                boxes.append({'confidence': round(confidence, 4), 'box': box})
        return boxes
