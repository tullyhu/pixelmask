import Foundation
import AVFoundation
import Vision
import CoreGraphics

private let scanIntervalSeconds: Double = 0.5
private let scanClusterGapSeconds: Double = 2.0
private let scanClusterIoU: Double = 0.2
private let scanMinDetections = 2

private struct FaceCluster {
    var keyframes: [(frame: Int, rect: CGRect)]
    var lastTime: Double
    var lastRect: CGRect
}

private func rectIoU(_ a: CGRect, _ b: CGRect) -> Double {
    let inter = a.intersection(b)
    if inter.isNull || inter.width <= 0 || inter.height <= 0 { return 0 }
    let interArea = Double(inter.width * inter.height)
    let union = Double(a.width * a.height + b.width * b.height) - interArea
    return union > 0 ? interArea / union : 0
}

func scanFaces(path: String) async throws -> [String: Any] {
    let info = try await loadVideoInfo(path: path)
    let reader = try AVAssetReader(asset: info.asset)
    let output = AVAssetReaderTrackOutput(
        track: info.track,
        outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    )
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw EngineError.decodeFailed(path) }
    reader.add(output)
    guard reader.startReading() else { throw EngineError.decodeFailed(path) }

    let request = DetectFaceRectanglesRequest()
    var clusters: [FaceCluster] = []
    var nextSampleTime = 0.0

    while let sampleBuffer = output.copyNextSampleBuffer() {
        if Task.isCancelled { reader.cancelReading(); throw CancellationError() }
        let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        guard t >= nextSampleTime else { continue }
        nextSampleTime = t + scanIntervalSeconds
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }

        let observations = (try? await request.perform(on: pixelBuffer, orientation: .up)) ?? []
        let frame = Int((t * info.fps).rounded())
        for obs in observations {
            let normalized = Geometry.visionToUprightNormalized(
                obs.boundingBox.cgRect, naturalSize: info.naturalSize, transform: info.transform)
            let expanded = normalized.insetBy(
                dx: -normalized.width * 0.15, dy: -normalized.height * 0.15
            ).clampedToUnit()
            let rect = CGRect(
                x: expanded.minX * info.upright.width,
                y: expanded.minY * info.upright.height,
                width: expanded.width * info.upright.width,
                height: expanded.height * info.upright.height
            )
            if let index = clusters.firstIndex(where: {
                t - $0.lastTime <= scanClusterGapSeconds && rectIoU($0.lastRect, rect) > scanClusterIoU
            }) {
                clusters[index].keyframes.append((frame, rect))
                clusters[index].lastTime = t
                clusters[index].lastRect = rect
            } else {
                clusters.append(FaceCluster(keyframes: [(frame, rect)], lastTime: t, lastRect: rect))
            }
        }
        await Task.yield()
    }

    let tracks: [[String: Any]] = clusters
        .filter { $0.keyframes.count >= scanMinDetections }
        .map { cluster in
            [
                "keyframes": cluster.keyframes.map { kf in
                    [
                        "frame": kf.frame,
                        "x": Double(kf.rect.minX.rounded()),
                        "y": Double(kf.rect.minY.rounded()),
                        "w": Double(max(4, kf.rect.width).rounded()),
                        "h": Double(max(4, kf.rect.height).rounded()),
                    ] as [String: Any]
                },
            ]
        }

    FileHandle.standardError.write(Data(
        "[scan] path=\(path) clusters=\(clusters.count) kept=\(tracks.count)\n".utf8))
    return ["tracks": tracks]
}
