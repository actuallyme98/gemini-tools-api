import { Module } from '@nestjs/common';
import { ImageJobsService } from './image-jobs.service';

@Module({ providers: [ImageJobsService], exports: [ImageJobsService] })
export class ImageJobsModule {}
