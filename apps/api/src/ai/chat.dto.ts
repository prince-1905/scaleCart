import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_HISTORY } from './shopping-assistant.js';

/**
 * Plain text only. The browser never sends tool calls or tool results: the server
 * rebuilds those itself on every message, so a client can't fake "the tool said…".
 */
export class ChatMessageDto {
  /** `assistant` = an earlier reply of the assistant. */
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text: string;
}

export class ChatDto {
  /** The conversation so far, oldest first. The last message must be the user's. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_HISTORY)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
}
