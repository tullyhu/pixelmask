import Foundation
import AVFoundation
import Vision
import CoreGraphics

enum EngineError: LocalizedError {
    case noVideoTrack(String)
    case decodeFailed(String)
    case badRequest(String)

    var errorDescription: String? {
        switch self {
        case .noVideoTrack(let p): return "找不到视频轨道: \(p)"
        case .decodeFailed(let p): return "视频解码失败: \(p)"
        case .badRequest(let m): return m
        }
    }
}

struct VideoInfo {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let naturalSize: CGSize
    let transform: CGAffineTransform
    let upright: CGSize
    let fps: Double
    let duration: Double
    let hasAudio: Bool
}

func loadVideoInfo(path: String) async throws -> VideoInfo {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
        throw EngineError.noVideoTrack(path)
    }
    let naturalSize = try await track.load(.naturalSize)
    let transform = try await track.load(.preferredTransform)
    let nominalFrameRate = try await track.load(.nominalFrameRate)
    let duration = try await asset.load(.duration)
    let audio = try await asset.loadTracks(withMediaType: .audio).first != nil
    return VideoInfo(
        asset: asset, track: track,
        naturalSize: naturalSize, transform: transform,
        upright: Geometry.uprightSize(naturalSize: naturalSize, transform: transform),
        fps: max(Double(nominalFrameRate), 1),
        duration: CMTimeGetSeconds(duration),
        hasAudio: audio
    )
}

func probe(path: String) async throws -> [String: Any] {
    let info = try await loadVideoInfo(path: path)
    return [
        "duration": info.duration,
        "fps": (info.fps * 1000).rounded() / 1000,
        "width": Int(info.upright.width),
        "height": Int(info.upright.height),
        "has_audio": info.hasAudio,
    ]
}

func detectFaces(path: String, frame: Int) async throws -> [String: Any] {
    let info = try await loadVideoInfo(path: path)
    let generator = AVAssetImageGenerator(asset: info.asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let time = CMTime(seconds: Double(frame) / info.fps, preferredTimescale: 600)
    let cgImage: CGImage
    do {
        cgImage = try await generator.image(at: time).image
    } catch {
        throw EngineError.decodeFailed("第 \(frame) 帧")
    }
    let request = DetectFaceRectanglesRequest()
    let observations = (try? await request.perform(on: cgImage, orientation: .up)) ?? []
    let W = Double(cgImage.width)
    let H = Double(cgImage.height)
    let boxes: [[String: Any]] = observations.map { obs in
        let b = obs.boundingBox.cgRect
        return [
            "x": max(0, min(W, Double(b.minX) * W)),
            "y": max(0, min(H, (1 - Double(b.maxY)) * H)),
            "w": max(4, min(W, Double(b.width) * W)),
            "h": max(4, min(H, Double(b.height) * H)),
            "conf": Double(obs.confidence),
            "kind": "face",
        ]
    }
    FileHandle.standardError.write(Data("[detect] frame=\(frame) boxes=\(boxes.count)\n".utf8))
    return ["boxes": boxes]
}
