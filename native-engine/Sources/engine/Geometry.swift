import Foundation
import CoreGraphics
import ImageIO

enum Geometry {
    static func visionOrientation(from transform: CGAffineTransform) -> CGImagePropertyOrientation {
        if transform.a == 0 && transform.b == 1 && transform.c == -1 && transform.d == 0 { return .right }
        if transform.a == 0 && transform.b == -1 && transform.c == 1 && transform.d == 0 { return .left }
        if transform.a == -1 && transform.b == 0 && transform.c == 0 && transform.d == -1 { return .down }
        return .up
    }

    static func uprightSize(naturalSize: CGSize, transform: CGAffineTransform) -> CGSize {
        let rect = CGRect(origin: .zero, size: naturalSize).applying(transform).standardized
        return CGSize(width: abs(rect.width), height: abs(rect.height))
    }

    static func uprightNormalizedToVision(_ rect: CGRect, naturalSize: CGSize, transform: CGAffineTransform) -> CGRect {
        let upSize = uprightSize(naturalSize: naturalSize, transform: transform)
        let upPixels = CGRect(
            x: rect.minX * upSize.width,
            y: rect.minY * upSize.height,
            width: rect.width * upSize.width,
            height: rect.height * upSize.height
        )
        let rawPixels = upPixels.applying(transform.inverted()).standardized
        let x = rawPixels.minX / naturalSize.width
        let y = rawPixels.minY / naturalSize.height
        let w = rawPixels.width / naturalSize.width
        let h = rawPixels.height / naturalSize.height
        return CGRect(x: x, y: 1 - y - h, width: w, height: h)
    }

    static func visionToUprightNormalized(_ vnRect: CGRect, naturalSize: CGSize, transform: CGAffineTransform) -> CGRect {
        let upSize = uprightSize(naturalSize: naturalSize, transform: transform)
        let rawPixels = CGRect(
            x: vnRect.minX * naturalSize.width,
            y: (1 - vnRect.maxY) * naturalSize.height,
            width: vnRect.width * naturalSize.width,
            height: vnRect.height * naturalSize.height
        )
        let upPixels = rawPixels.applying(transform).standardized
        let transformedOrigin = CGRect(origin: .zero, size: naturalSize).applying(transform).standardized
        let x = (upPixels.minX - transformedOrigin.minX) / upSize.width
        let y = (upPixels.minY - transformedOrigin.minY) / upSize.height
        return CGRect(
            x: x, y: y,
            width: upPixels.width / upSize.width,
            height: upPixels.height / upSize.height
        ).clampedToUnit()
    }
}

extension CGRect {
    func clampedToUnit() -> CGRect {
        let minX = max(self.minX, 0)
        let minY = max(self.minY, 0)
        let maxX = min(self.maxX, 1)
        let maxY = min(self.maxY, 1)
        guard maxX > minX, maxY > minY else { return .zero }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

func jsonNumber(_ value: Any?) -> Double? {
    (value as? NSNumber)?.doubleValue
}

func jsonInt(_ value: Any?) -> Int? {
    (value as? NSNumber)?.intValue
}
