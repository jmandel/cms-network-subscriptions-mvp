import type { SimulationState, SourceFixture } from "./types";

export const NETWORK_ACTIVITY_TOPIC =
  "https://cms.gov/fhir/SubscriptionTopic/network-activity";

export const PATIENT_DATA_FEED_TOPIC =
  "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed";

export const PATIENT_ID = "network-patient-123";

export const sources: SourceFixture[] = [
  {
    id: "valley",
    name: "Valley Clinic",
    npi: "1234567890",
    kind: "Outpatient",
    sensitive: false,
    supportsQuery: true,
    supportsFeed: true,
    endpoint: "https://valley-clinic.example.org/fhir",
    feedEndpoint: "https://valley-clinic.example.org/fhir",
    patientId: "source-patient-valley",
  },
  {
    id: "mercy",
    name: "Mercy Hospital Phoenix",
    npi: "2234567890",
    kind: "Hospital",
    sensitive: false,
    supportsQuery: true,
    supportsFeed: true,
    endpoint: "https://mercy-phoenix.example.org/fhir",
    feedEndpoint: "https://network.example.org/fhir/sources/mercy",
    patientId: "source-patient-mercy",
  },
  {
    id: "northside",
    name: "Northside Behavioral Health",
    npi: "3234567890",
    kind: "Behavioral health",
    sensitive: true,
    supportsQuery: true,
    supportsFeed: false,
    endpoint: "https://northside-behavioral.example.org/fhir",
    feedEndpoint: "https://northside-behavioral.example.org/fhir",
    patientId: "source-patient-northside",
  },
];

export function createInitialState(): SimulationState {
  const sourceMap = Object.fromEntries(
    sources.map((source) => [
      source.id,
      {
        ...source,
        feedEnabled: source.supportsFeed,
      },
    ]),
  );

  return {
    app: {
      patientId: PATIENT_ID,
      knownSources: {},
      feedSubscriptions: {},
      sourceTokens: {},
      lastNetworkEventNumber: 0,
      seenActivityIds: [],
      pendingActions: [],
      pendingReads: [],
      decisions: [],
    },
    network: {
      disclosurePolicy: "feed-endpoint",
      eventCounter: 0,
      dropNextWebhook: false,
      handles: {},
    },
    sources: sourceMap,
    resources: {
      valley: {
        Encounter: [
          {
            resourceType: "Encounter",
            id: "enc-valley-1",
            status: "finished",
            class: { code: "AMB", display: "ambulatory" },
            subject: { reference: "Patient/source-patient-valley" },
            period: { start: "2026-04-29T15:25:00Z" },
            serviceProvider: { display: "Valley Clinic" },
            meta: { lastUpdated: "2026-04-29T15:35:00Z" },
          },
        ],
        Appointment: [
          {
            resourceType: "Appointment",
            id: "appt-valley-1",
            status: "booked",
            start: "2026-05-05T14:00:00Z",
            participant: [{ actor: { reference: "Patient/source-patient-valley" } }],
            meta: { lastUpdated: "2026-04-29T15:40:00Z" },
          },
        ],
      },
      mercy: {
        Encounter: [
          {
            resourceType: "Encounter",
            id: "enc-mercy-1",
            status: "in-progress",
            class: { code: "EMER", display: "emergency" },
            subject: { reference: "Patient/source-patient-mercy" },
            period: { start: "2026-04-29T16:10:00Z" },
            serviceProvider: { display: "Mercy Hospital Phoenix" },
            meta: { lastUpdated: "2026-04-29T16:15:00Z" },
          },
        ],
        Appointment: [],
      },
      northside: {
        Encounter: [
          {
            resourceType: "Encounter",
            id: "enc-northside-1",
            status: "finished",
            class: { code: "AMB", display: "ambulatory" },
            subject: { reference: "Patient/source-patient-northside" },
            period: { start: "2026-04-29T16:20:00Z" },
            serviceProvider: { display: "Northside Behavioral Health" },
            meta: { lastUpdated: "2026-04-29T16:25:00Z" },
          },
        ],
        Appointment: [],
      },
    },
    trace: [],
  };
}
