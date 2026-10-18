import "reflect-metadata";
import { Module } from "@nestjs/common";
/** Empty host composition. No scheduler, persistence, or auth in Phase 0. */
@Module({})
export class AppModule {}
