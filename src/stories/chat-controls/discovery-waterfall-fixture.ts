import type { FlowTrace } from "../../trace"

/** Recorded Discovery contract-canary trace; see discovery-waterfall-provenance.md. */
export const discoveryWaterfallTrace: FlowTrace = {
  "spans": [
    {
      "id": "agent-0",
      "kind": "pipeline",
      "name": "Discovery orchestrator",
      "startMs": 0,
      "endMs": 430758,
      "status": "done"
    },
    {
      "id": "agent-1",
      "kind": "pipeline",
      "name": "Echo worker",
      "startMs": 43393,
      "endMs": 334348,
      "status": "done",
      "parentId": "agent-0"
    },
    {
      "id": "tool-0",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "read",
      "startMs": 31154,
      "endMs": 31213,
      "status": "done"
    },
    {
      "id": "tool-1",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "read",
      "startMs": 31255,
      "endMs": 31309,
      "status": "done"
    },
    {
      "id": "tool-2",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "glob",
      "startMs": 32878,
      "endMs": 32898,
      "status": "done"
    },
    {
      "id": "tool-3",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "read",
      "startMs": 32953,
      "endMs": 32972,
      "status": "done"
    },
    {
      "id": "tool-4",
      "parentId": "agent-0",
      "kind": "handoff",
      "name": "spawn_worker",
      "startMs": 41408,
      "endMs": 41651,
      "status": "done"
    },
    {
      "id": "tool-5",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "steer_agent",
      "startMs": 44303,
      "endMs": 49850,
      "status": "done"
    },
    {
      "id": "tool-6",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "bash",
      "startMs": 61765,
      "endMs": 91825,
      "status": "done"
    },
    {
      "id": "tool-7",
      "parentId": "agent-1",
      "kind": "tool",
      "name": "knowledge_record",
      "startMs": 70957,
      "endMs": 78444,
      "status": "done"
    },
    {
      "id": "tool-8",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "steer_agent",
      "startMs": 93386,
      "endMs": 95564,
      "status": "done"
    },
    {
      "id": "tool-9",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_read",
      "startMs": 96969,
      "endMs": 97799,
      "status": "done"
    },
    {
      "id": "tool-10",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_resolve",
      "startMs": 98891,
      "endMs": 99083,
      "status": "done"
    },
    {
      "id": "tool-11",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_search",
      "startMs": 100755,
      "endMs": 105931,
      "status": "done"
    },
    {
      "id": "tool-12",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_record",
      "startMs": 114842,
      "endMs": 118641,
      "status": "done"
    },
    {
      "id": "tool-13",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "observe_agent",
      "startMs": 122023,
      "endMs": 122212,
      "status": "done"
    },
    {
      "id": "tool-14",
      "parentId": "agent-1",
      "kind": "tool",
      "name": "knowledge_read",
      "startMs": 124204,
      "endMs": 124583,
      "status": "done"
    },
    {
      "id": "tool-15",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "bash",
      "startMs": 124958,
      "endMs": 169971,
      "status": "done"
    },
    {
      "id": "tool-16",
      "parentId": "agent-1",
      "kind": "tool",
      "name": "knowledge_record",
      "startMs": 126158,
      "endMs": 127510,
      "status": "failed"
    },
    {
      "id": "tool-17",
      "parentId": "agent-1",
      "kind": "tool",
      "name": "knowledge_read",
      "startMs": 130361,
      "endMs": 130646,
      "status": "done"
    },
    {
      "id": "tool-18",
      "parentId": "agent-1",
      "kind": "tool",
      "name": "knowledge_read",
      "startMs": 145465,
      "endMs": 146163,
      "status": "done"
    },
    {
      "id": "tool-19",
      "parentId": "agent-1",
      "kind": "tool",
      "name": "knowledge_record",
      "startMs": 152823,
      "endMs": 157478,
      "status": "done"
    },
    {
      "id": "tool-20",
      "parentId": "agent-1",
      "kind": "tool",
      "name": "submit_result",
      "startMs": 161642,
      "endMs": 162479,
      "status": "done"
    },
    {
      "id": "tool-21",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "observe_agent",
      "startMs": 173301,
      "endMs": 173572,
      "status": "done"
    },
    {
      "id": "tool-22",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "bash",
      "startMs": 176005,
      "endMs": 236029,
      "status": "done"
    },
    {
      "id": "tool-23",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "observe_agent",
      "startMs": 240619,
      "endMs": 240915,
      "status": "done"
    },
    {
      "id": "tool-24",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "bash",
      "startMs": 245180,
      "endMs": 245193,
      "status": "done"
    },
    {
      "id": "tool-25",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_read",
      "startMs": 247728,
      "endMs": 247997,
      "status": "done"
    },
    {
      "id": "tool-26",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_record",
      "startMs": 273705,
      "endMs": 273901,
      "status": "failed"
    },
    {
      "id": "tool-27",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "bash",
      "startMs": 281753,
      "endMs": 281763,
      "status": "done"
    },
    {
      "id": "tool-28",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "write",
      "startMs": 288280,
      "endMs": 288288,
      "status": "done"
    },
    {
      "id": "tool-29",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_record",
      "startMs": 301376,
      "endMs": 302305,
      "status": "failed"
    },
    {
      "id": "tool-30",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_record",
      "startMs": 315017,
      "endMs": 317214,
      "status": "done"
    },
    {
      "id": "tool-31",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "submit_result",
      "startMs": 326385,
      "endMs": 326580,
      "status": "done"
    },
    {
      "id": "tool-32",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_resolve",
      "startMs": 371681,
      "endMs": 371893,
      "status": "done"
    },
    {
      "id": "tool-33",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "knowledge_search",
      "startMs": 376206,
      "endMs": 376960,
      "status": "done"
    },
    {
      "id": "tool-34",
      "parentId": "agent-0",
      "kind": "tool",
      "name": "submit_result",
      "startMs": 388921,
      "endMs": 389114,
      "status": "done"
    },
    {
      "id": "model-0",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 30783,
      "endMs": 31239,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-1",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 32770,
      "endMs": 33222,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-2",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 34266,
      "endMs": 35742,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-3",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 43012,
      "endMs": 44317,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-4",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 61394,
      "endMs": 61806,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-5",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 97404,
      "endMs": 97420,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-6",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 100527,
      "endMs": 100947,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-7",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 109912,
      "endMs": 114289,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-8",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 125092,
      "endMs": 125093,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-9",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 243923,
      "endMs": 244958,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-10",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 251059,
      "endMs": 257794,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-11",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 277600,
      "endMs": 282121,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-12",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 330813,
      "endMs": 371475,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-13",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 379957,
      "endMs": 382975,
      "status": "done",
      "approx": true
    },
    {
      "id": "model-14",
      "parentId": "agent-0",
      "kind": "model",
      "name": "Root reasoning / text output",
      "startMs": 392970,
      "endMs": 398063,
      "status": "done",
      "approx": true
    },
    {
      "id": "root-first-output",
      "parentId": "agent-0",
      "kind": "waiting",
      "name": "Admission \u2192 first recorded reasoning",
      "startMs": 0,
      "endMs": 30783,
      "status": "done",
      "approx": true
    }
  ],
  "totalMs": 430758,
  "promptTokens": 748706,
  "completionTokens": 5742,
  "toolCalls": 35,
  "errors": 3
}
