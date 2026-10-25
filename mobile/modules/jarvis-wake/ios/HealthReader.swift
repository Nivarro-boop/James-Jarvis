import ExpoModulesCore
import Foundation
import HealthKit

/// Apple Health, nur lesen.
///
/// Gelesen werden Tagessummen, keine Einzelmessungen: Schritte, Strecke,
/// aktive Energie, Trainingsminuten, Stockwerke, Schlaf und Ruhepuls für die
/// letzten Tage, dazu der letzte Puls und das letzte Gewicht. Das reicht für
/// „wie viele Schritte heute" und „wie hab ich geschlafen", und es ist so wenig
/// wie möglich, was das iPhone verlässt.
///
/// HealthKit verrät einer App nie, ob sie Lesezugriff bekommen hat — eine
/// abgelehnte Art liefert einfach keine Werte. Deshalb fehlen Felder still,
/// statt einen Fehler zu werfen.
final class HealthReader {
  static let shared = HealthReader()
  private let store = HKHealthStore()

  var available: Bool { HKHealthStore.isHealthDataAvailable() }

  private let sums: [(key: String, id: HKQuantityTypeIdentifier, unit: HKUnit)] = [
    ("steps", .stepCount, .count()),
    ("distanceKm", .distanceWalkingRunning, .meterUnit(with: .kilo)),
    ("activeKcal", .activeEnergyBurned, .kilocalorie()),
    ("exerciseMin", .appleExerciseTime, .minute()),
    ("flights", .flightsClimbed, .count())
  ]

  private var readTypes: Set<HKObjectType> {
    var types = Set<HKObjectType>()
    for sum in sums { types.insert(HKQuantityType(sum.id)) }
    types.insert(HKQuantityType(.restingHeartRate))
    types.insert(HKQuantityType(.heartRate))
    types.insert(HKQuantityType(.bodyMass))
    types.insert(HKCategoryType(.sleepAnalysis))
    return types
  }

  func requestAccess() async throws -> Bool {
    guard available else { return false }
    try await store.requestAuthorization(toShare: [], read: readTypes)
    return true
  }

  /// Tageswerte der letzten `days` Tage, neueste zuerst, im Format von
  /// `src/shared/health.ts` am Rechner.
  func summary(days: Int) async throws -> [String: Any] {
    guard available else { throw HealthException("Apple Health gibt es auf diesem Gerät nicht.") }
    let count = max(1, min(days, 7))
    let calendar = Calendar.current
    let now = Date()
    let today = calendar.startOfDay(for: now)
    guard let start = calendar.date(byAdding: .day, value: -(count - 1), to: today) else { return [:] }

    var perDay: [Date: [String: Any]] = [:]
    for offset in 0..<count {
      if let day = calendar.date(byAdding: .day, value: offset, to: start) {
        perDay[day] = ["date": isoDay(day, calendar)]
      }
    }

    for sum in sums {
      let values = (try? await dailySums(sum.id, unit: sum.unit, from: start, to: now, anchor: today)) ?? [:]
      for (day, value) in values where perDay[day] != nil { perDay[day]?[sum.key] = value }
    }

    let resting = (try? await dailyAverage(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), from: start, to: now, anchor: today)) ?? [:]
    for (day, value) in resting where perDay[day] != nil { perDay[day]?["restingHeartRate"] = value }

    let sleep = (try? await sleepHours(days: Array(perDay.keys), calendar: calendar)) ?? [:]
    for (day, value) in sleep where perDay[day] != nil { perDay[day]?["sleepHours"] = value }

    var result: [String: Any] = [
      "takenAt": now.timeIntervalSince1970 * 1000,
      "days": perDay.keys.sorted(by: >).compactMap { perDay[$0] }
    ]
    if let heart = try? await latest(.heartRate, unit: HKUnit.count().unitDivided(by: .minute())) {
      result["heartRate"] = ["bpm": heart.value, "at": heart.at]
    }
    if let weight = try? await latest(.bodyMass, unit: .gramUnit(with: .kilo)) {
      result["weight"] = ["kg": weight.value, "at": weight.at]
    }
    return result
  }

  private func isoDay(_ date: Date, _ calendar: Calendar) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  private func dailySums(_ id: HKQuantityTypeIdentifier, unit: HKUnit, from start: Date, to end: Date, anchor: Date) async throws -> [Date: Double] {
    try await daily(id, options: .cumulativeSum, from: start, to: end, anchor: anchor) { $0.sumQuantity()?.doubleValue(for: unit) }
  }

  private func dailyAverage(_ id: HKQuantityTypeIdentifier, unit: HKUnit, from start: Date, to end: Date, anchor: Date) async throws -> [Date: Double] {
    try await daily(id, options: .discreteAverage, from: start, to: end, anchor: anchor) { $0.averageQuantity()?.doubleValue(for: unit) }
  }

  /// Eine Statistik je Kalendertag. HealthKit führt dabei Quellen zusammen —
  /// Schritte von iPhone und Watch zählen nicht doppelt.
  private func daily(_ id: HKQuantityTypeIdentifier, options: HKStatisticsOptions, from start: Date, to end: Date, anchor: Date, value: @escaping (HKStatistics) -> Double?) async throws -> [Date: Double] {
    let type = HKQuantityType(id)
    let predicate = HKSamplePredicate.quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end))
    let query = HKStatisticsCollectionQueryDescriptor(predicate: predicate, options: options, anchorDate: anchor, intervalComponents: DateComponents(day: 1))
    let collection = try await query.result(for: store)
    var out: [Date: Double] = [:]
    collection.enumerateStatistics(from: start, to: end) { statistics, _ in
      if let number = value(statistics) { out[statistics.startDate] = (number * 10).rounded() / 10 }
    }
    return out
  }

  private func latest(_ id: HKQuantityTypeIdentifier, unit: HKUnit) async throws -> (value: Double, at: Double)? {
    let type = HKQuantityType(id)
    let query = HKSampleQueryDescriptor(
      predicates: [.quantitySample(type: type)],
      sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)],
      limit: 1
    )
    guard let sample = try await query.result(for: store).first else { return nil }
    return (sample.quantity.doubleValue(for: unit), sample.endDate.timeIntervalSince1970 * 1000)
  }

  /// Schlaf der Nacht, die am Morgen des jeweiligen Tages endet (18 Uhr am
  /// Vortag bis 12 Uhr). Überlappende Einträge von iPhone und Watch werden zu
  /// Zeitspannen verschmolzen, sonst zählte dieselbe Stunde doppelt.
  private func sleepHours(days: [Date], calendar: Calendar) async throws -> [Date: Double] {
    guard let first = days.min(), let last = days.max(),
          let from = calendar.date(byAdding: .hour, value: -6, to: first),
          let to = calendar.date(byAdding: .hour, value: 12, to: last) else { return [:] }
    let type = HKCategoryType(.sleepAnalysis)
    let asleep = HKCategoryValueSleepAnalysis.allAsleepValues.map(\.rawValue)
    let query = HKSampleQueryDescriptor(
      predicates: [.categorySample(type: type, predicate: HKQuery.predicateForSamples(withStart: from, end: to))],
      sortDescriptors: [SortDescriptor(\.startDate)]
    )
    let samples = try await query.result(for: store).filter { asleep.contains($0.value) }

    var out: [Date: Double] = [:]
    for day in days {
      guard let windowStart = calendar.date(byAdding: .hour, value: -6, to: day),
            let windowEnd = calendar.date(byAdding: .hour, value: 12, to: day) else { continue }
      var spans: [(Date, Date)] = []
      for sample in samples {
        let s = max(sample.startDate, windowStart), e = min(sample.endDate, windowEnd)
        if e > s { spans.append((s, e)) }
      }
      spans.sort { $0.0 < $1.0 }
      var total: TimeInterval = 0
      var current: (Date, Date)?
      for span in spans {
        if let open = current, span.0 <= open.1 {
          current = (open.0, max(open.1, span.1))
        } else {
          if let open = current { total += open.1.timeIntervalSince(open.0) }
          current = span
        }
      }
      if let open = current { total += open.1.timeIntervalSince(open.0) }
      if total > 0 { out[day] = (total / 360).rounded() / 10 }
    }
    return out
  }
}

final class HealthException: GenericException<String> {
  override var reason: String { param }
}
