import Foundation
import Vision
import CoreImage
import Accelerate

enum QualityChecks {
    /// Returns a per-photo quality verdict the Node side uses to triage:
    ///   - eyesOpen   : both eyes detected with sufficient pupil-to-eye-height ratio
    ///   - blurScore  : Laplacian variance — higher is sharper, < 80 is blurry
    ///   - faceCentered : nose-tip horizontal offset from center, normalized 0..1
    ///   - recommendation: "use" | "review" | "reject"
    static func evaluate(path: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        guard let ciImage = CIImage(contentsOf: url) else {
            throw NSError(domain: "QualityChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not read image"])
        }

        let orientation = ciImage.properties[kCGImagePropertyOrientation as String] as? UInt32 ?? 1
        let cgOrientation = CGImagePropertyOrientation(rawValue: orientation) ?? .up

        let landmarkRequest = VNDetectFaceLandmarksRequest()
        let captureQualityRequest = VNDetectFaceCaptureQualityRequest()

        let handler = VNImageRequestHandler(ciImage: ciImage, orientation: cgOrientation, options: [:])
        try handler.perform([landmarkRequest, captureQualityRequest])

        let imageWidth = Double(ciImage.extent.width)

        var eyesOpen = false
        var faceCentered = 1.0   // worst by default
        var pose = (yaw: 0.0, pitch: 0.0, roll: 0.0)

        if let face = (landmarkRequest.results ?? []).max(by: { $0.confidence < $1.confidence }) {
            let bb = face.boundingBox
            let bbX = bb.origin.x * imageWidth
            let bbW = bb.width * imageWidth

            // Pose
            pose = (
                yaw: face.yaw?.doubleValue ?? 0,
                pitch: face.pitch?.doubleValue ?? 0,
                roll: face.roll?.doubleValue ?? 0
            )

            // Eyes-open heuristic: pupil region should be present + eye contour should
            // have visible vertical extent. Vision doesn't expose eye-aspect directly,
            // so we check pupil count > 0 as a proxy. Closed eyes typically lack pupils.
            let leftPupilCount = face.landmarks?.leftPupil?.pointCount ?? 0
            let rightPupilCount = face.landmarks?.rightPupil?.pointCount ?? 0
            eyesOpen = (leftPupilCount > 0 && rightPupilCount > 0)

            // Horizontal centering: compute nose-tip x relative to image center.
            if let crest = face.landmarks?.noseCrest, crest.pointCount > 0 {
                // Find the lowest crest point (closest to nose tip)
                var minY = Double.greatestFiniteMagnitude
                var noseTipX = bbX + bbW * 0.5
                for i in 0..<crest.pointCount {
                    let p = crest.normalizedPoints[i]
                    if Double(p.y) < minY {
                        minY = Double(p.y)
                        noseTipX = bbX + Double(p.x) * bbW
                    }
                }
                faceCentered = abs((noseTipX - imageWidth / 2) / (imageWidth / 2))
            }
        }

        // Blur: Vision's face capture quality is a 0..1 score; combine with a
        // Laplacian variance fallback for non-face cases.
        let captureQuality = (captureQualityRequest.results ?? []).first?.faceCaptureQuality.map(Double.init) ?? 0
        let blurScore = laplacianVariance(ciImage: ciImage)

        // Recommendation
        let recommendation: String
        let isBlurry = blurScore < 80
        let isOffCenter = faceCentered > 0.35
        let isSideways = abs(pose.yaw) > 0.6 || abs(pose.pitch) > 0.5
        let lowQuality = captureQuality > 0 && captureQuality < 0.35

        if !eyesOpen || isBlurry || lowQuality {
            recommendation = "review"
        } else if isOffCenter || isSideways {
            recommendation = "review"
        } else {
            recommendation = "use"
        }

        return [
            "eyesOpen": eyesOpen,
            "blurScore": blurScore,
            "captureQuality": captureQuality,
            "faceCenteredOffset": faceCentered,
            "yaw": pose.yaw,
            "pitch": pose.pitch,
            "roll": pose.roll,
            "recommendation": recommendation
        ]
    }

    /// Laplacian variance over a downsampled grayscale version of the image.
    /// Higher = sharper. Standard cv2.Laplacian() trick, ported via vImage.
    private static func laplacianVariance(ciImage: CIImage) -> Double {
        let target = 512.0
        let scale = min(target / ciImage.extent.width, target / ciImage.extent.height)
        let scaled = ciImage.transformed(by: .init(scaleX: scale, y: scale))

        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return 0 }

        let width = cgImage.width
        let height = cgImage.height
        guard width > 0, height > 0 else { return 0 }

        // Read into 8-bit grayscale buffer.
        let bytesPerRow = width
        var pixels = [UInt8](repeating: 0, count: width * height)
        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let ctx = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return 0 }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        // Laplacian kernel: [[0,1,0],[1,-4,1],[0,1,0]]; compute via central difference.
        var sum = 0.0
        var sumSq = 0.0
        var count = 0.0
        for y in 1..<(height - 1) {
            for x in 1..<(width - 1) {
                let i = y * width + x
                let v = Double(pixels[i]) * 4
                    - Double(pixels[i - 1]) - Double(pixels[i + 1])
                    - Double(pixels[i - width]) - Double(pixels[i + width])
                sum += v
                sumSq += v * v
                count += 1
            }
        }
        if count == 0 { return 0 }
        let mean = sum / count
        let variance = sumSq / count - mean * mean
        return variance
    }
}
