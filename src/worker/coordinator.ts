import { DurableObject } from "cloudflare:workers";

export interface TransmissionReservation {
  submissionId: string;
  sequence: number;
  remoteFilename: string;
  stage: string;
  updatedAt: number;
}

interface ReservationRow extends Record<string, SqlStorageValue> {
  submission_id: string;
  sequence: number;
  remote_filename: string;
  stage: string;
  updated_at: number;
}

export class TransmissionCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sequence_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_value INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reservations (
          submission_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
          remote_filename TEXT NOT NULL UNIQUE,
          stage TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO sequence_state (singleton, next_value) VALUES (1, 1);
      `);
    });
  }

  reserve(submissionId: string, remoteFilename: string): TransmissionReservation {
    const existing = this.ctx.storage.sql
      .exec<ReservationRow>("SELECT * FROM reservations WHERE submission_id = ?", submissionId)
      .toArray()[0];
    if (existing) {
      return mapReservation(existing);
    }

    const sequenceRow = this.ctx.storage.sql
      .exec<{ next_value: number }>("SELECT next_value FROM sequence_state WHERE singleton = 1")
      .one();
    const sequence = sequenceRow.next_value;
    const updatedAt = Date.now();
    this.ctx.storage.sql.exec("UPDATE sequence_state SET next_value = next_value + 1 WHERE singleton = 1");
    this.ctx.storage.sql.exec(
      `INSERT INTO reservations (submission_id, sequence, remote_filename, stage, updated_at)
       VALUES (?, ?, ?, 'RESERVED', ?)`,
      submissionId,
      sequence,
      remoteFilename,
      updatedAt,
    );
    return { submissionId, sequence, remoteFilename, stage: "RESERVED", updatedAt };
  }

  markStage(submissionId: string, stage: string): TransmissionReservation {
    const updatedAt = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE reservations SET stage = ?, updated_at = ? WHERE submission_id = ?",
      stage,
      updatedAt,
      submissionId,
    );
    const row = this.ctx.storage.sql
      .exec<ReservationRow>("SELECT * FROM reservations WHERE submission_id = ?", submissionId)
      .one();
    return mapReservation(row);
  }

  getReservation(submissionId: string): TransmissionReservation | null {
    const row = this.ctx.storage.sql
      .exec<ReservationRow>("SELECT * FROM reservations WHERE submission_id = ?", submissionId)
      .toArray()[0];
    return row ? mapReservation(row) : null;
  }
}

function mapReservation(row: ReservationRow): TransmissionReservation {
  return {
    submissionId: row.submission_id,
    sequence: row.sequence,
    remoteFilename: row.remote_filename,
    stage: row.stage,
    updatedAt: row.updated_at,
  };
}
