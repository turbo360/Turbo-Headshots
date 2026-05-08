import Foundation
import Vision
import CoreImage
import AppKit

enum ForegroundMask {
    /// Generates a person/foreground mask using Apple Vision and applies it to the source image,
    /// writing a transparent PNG to outputPath.
    static func generate(path: String, outputPath: String) throws {
        let url = URL(fileURLWithPath: path)
        guard let ciImage = CIImage(contentsOf: url) else {
            throw NSError(domain: "ForegroundMask", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not read image"])
        }

        let orientation = ciImage.properties[kCGImagePropertyOrientation as String] as? UInt32 ?? 1
        let cgOrientation = CGImagePropertyOrientation(rawValue: orientation) ?? .up

        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(ciImage: ciImage, orientation: cgOrientation, options: [:])
        try handler.perform([request])

        guard let observation = request.results?.first else {
            throw NSError(domain: "ForegroundMask", code: 2, userInfo: [NSLocalizedDescriptionKey: "No foreground detected"])
        }

        // Apply mask to all detected instances (typically just one person in a headshot).
        let maskedPixelBuffer = try observation.generateMaskedImage(
            ofInstances: observation.allInstances,
            from: handler,
            croppedToInstancesExtent: false
        )

        let masked = CIImage(cvPixelBuffer: maskedPixelBuffer)
        let context = CIContext()

        let outputURL = URL(fileURLWithPath: outputPath)
        try context.writePNGRepresentation(
            of: masked,
            to: outputURL,
            format: .RGBA8,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [:]
        )
    }
}
