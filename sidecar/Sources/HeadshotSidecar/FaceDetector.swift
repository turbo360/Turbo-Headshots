import Foundation
import Vision
import CoreImage

enum FaceDetector {
    /// Returns landmark-based geometry suitable for headshot framing.
    /// All coordinates are in the *oriented* image space (top-left origin, EXIF applied).
    static func detect(path: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        guard let ciImage = CIImage(contentsOf: url) else {
            throw NSError(domain: "FaceDetector", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not read image"])
        }

        let orientation = ciImage.properties[kCGImagePropertyOrientation as String] as? UInt32 ?? 1
        let cgOrientation = CGImagePropertyOrientation(rawValue: orientation) ?? .up

        // Compute the *oriented* image dimensions. Vision normalizes its
        // boundingBox / landmark coords to this oriented space.
        let sensorWidth = ciImage.extent.width
        let sensorHeight = ciImage.extent.height
        let isRotated90: Bool = {
            switch cgOrientation {
            case .left, .right, .leftMirrored, .rightMirrored: return true
            default: return false
            }
        }()
        let orientedWidth = isRotated90 ? sensorHeight : sensorWidth
        let orientedHeight = isRotated90 ? sensorWidth : sensorHeight

        let rectRequest = VNDetectFaceRectanglesRequest()
        let landmarkRequest = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(ciImage: ciImage, orientation: cgOrientation, options: [:])
        try handler.perform([rectRequest, landmarkRequest])

        // Pick the face with highest confidence (largest if tied).
        let observations = (landmarkRequest.results ?? []).sorted { a, b in
            if a.confidence != b.confidence { return a.confidence > b.confidence }
            return (a.boundingBox.width * a.boundingBox.height) > (b.boundingBox.width * b.boundingBox.height)
        }

        guard let face = observations.first else {
            return [
                "found": false,
                "imageWidth": Int(orientedWidth),
                "imageHeight": Int(orientedHeight)
            ]
        }

        // Convert Vision's normalized rect (0..1, bottom-left origin) to
        // top-left-origin pixel coords in the oriented image.
        let bb = face.boundingBox
        let bbX = bb.origin.x * orientedWidth
        let bbYFromBottom = bb.origin.y * orientedHeight
        let bbW = bb.width * orientedWidth
        let bbH = bb.height * orientedHeight
        let bbY = orientedHeight - bbYFromBottom - bbH

        // Defaults derived from boundingBox; will refine using landmarks if available.
        var eyeLineY: Double = bbY + bbH * 0.4
        var noseTipX: Double = bbX + bbW * 0.5
        var noseTipY: Double = bbY + bbH * 0.55
        var leftEyeRect: [String: Double]?
        var rightEyeRect: [String: Double]?
        var outerLipsRect: [String: Double]?
        var innerLipsRect: [String: Double]?

        if let landmarks = face.landmarks {
            // Each VNFaceLandmarkRegion2D point is normalized 0..1 within the face boundingBox.
            func pixelPoints(_ region: VNFaceLandmarkRegion2D?) -> [(Double, Double)] {
                guard let region else { return [] }
                return (0..<region.pointCount).map { idx in
                    let p = region.normalizedPoints[idx]
                    let px = bbX + Double(p.x) * bbW
                    let pyFromBottom = bbYFromBottom + Double(p.y) * bbH
                    let py = orientedHeight - pyFromBottom
                    return (px, py)
                }
            }

            let leftEye = pixelPoints(landmarks.leftEye)
            let rightEye = pixelPoints(landmarks.rightEye)
            let leftPupil = pixelPoints(landmarks.leftPupil)
            let rightPupil = pixelPoints(landmarks.rightPupil)
            let nose = pixelPoints(landmarks.nose)
            let noseCrest = pixelPoints(landmarks.noseCrest)
            let outerLips = pixelPoints(landmarks.outerLips)
            let innerLips = pixelPoints(landmarks.innerLips)

            // Bounding rects for eye and mouth regions, used by Node-side
            // region-targeted enhancement (eye sharpen, teeth desaturate).
            func rectFromPoints(_ pts: [(Double, Double)]) -> [String: Double]? {
                guard !pts.isEmpty else { return nil }
                let xs = pts.map { $0.0 }
                let ys = pts.map { $0.1 }
                let minX = xs.min()!, maxX = xs.max()!
                let minY = ys.min()!, maxY = ys.max()!
                return [
                    "x": minX, "y": minY,
                    "width": maxX - minX, "height": maxY - minY
                ]
            }
            leftEyeRect = rectFromPoints(leftEye)
            rightEyeRect = rectFromPoints(rightEye)
            outerLipsRect = rectFromPoints(outerLips)
            innerLipsRect = rectFromPoints(innerLips)

            func centroid(_ pts: [(Double, Double)]) -> (Double, Double)? {
                guard !pts.isEmpty else { return nil }
                let n = Double(pts.count)
                return (pts.reduce(0.0) { $0 + $1.0 } / n, pts.reduce(0.0) { $0 + $1.1 } / n)
            }

            let leftEyeCenter = centroid(leftPupil) ?? centroid(leftEye)
            let rightEyeCenter = centroid(rightPupil) ?? centroid(rightEye)

            if let l = leftEyeCenter, let r = rightEyeCenter {
                eyeLineY = (l.1 + r.1) / 2
            } else if let c = centroid(leftEye + rightEye) {
                eyeLineY = c.1
            }

            // Nose tip - lowest crest point (closest to nostrils) is the reliable apex.
            if let crest = noseCrest.max(by: { $0.1 < $1.1 }) {
                noseTipX = crest.0
                noseTipY = crest.1
            } else if let c = centroid(nose) {
                noseTipX = c.0
                noseTipY = c.1
            }
        }

        // Estimate top-of-head: forehead is ~25% of face height above the eye line;
        // hairline is typically another 5-10% above the forehead.
        let estimatedTopOfHead = max(0, bbY - bbH * 0.20)

        var result: [String: Any] = [
            "found": true,
            "confidence": Double(face.confidence),
            "imageWidth": Int(orientedWidth),
            "imageHeight": Int(orientedHeight),
            "orientation": Int(orientation),
            "boundingBox": [
                "x": bbX,
                "y": bbY,
                "width": bbW,
                "height": bbH
            ],
            "eyeLineY": eyeLineY,
            "noseTipX": noseTipX,
            "noseTipY": noseTipY,
            "estimatedTopOfHead": estimatedTopOfHead,
            "faceHeight": bbH,
            "yaw": face.yaw?.doubleValue ?? 0,
            "roll": face.roll?.doubleValue ?? 0,
            "pitch": face.pitch?.doubleValue ?? 0
        ]
        if let r = leftEyeRect { result["leftEyeRect"] = r }
        if let r = rightEyeRect { result["rightEyeRect"] = r }
        if let r = outerLipsRect { result["outerLipsRect"] = r }
        if let r = innerLipsRect { result["innerLipsRect"] = r }
        return result
    }
}
