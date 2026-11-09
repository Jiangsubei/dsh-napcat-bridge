/**
 * dsh-napcat-bridge: OneBot 11 原始报文与网关协议类型
 */

export type OneBotPostType = 'message' | 'message_sent' | 'notice' | 'request' | 'meta_event';

export type OneBotMessageType = 'group' | 'private';

export interface OneBotSender {
  user_id: number | string;
  nickname: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
  sex?: string;
  age?: number;
}

export type OneBotSegmentType =
  | 'text'
  | 'face'
  | 'image'
  | 'record'
  | 'video'
  | 'at'
  | 'reply'
  | 'file'
  | 'forward'
  | 'json'
  | 'xml'
  | 'poke'
  | 'shake'
  | 'rps'
  | 'dice'
  | 'contact'
  | 'location'
  | 'music'
  | 'share'
  | 'mface' // NapCat 市场表情/商城表情扩展
  | 'marketface'; // NapCat 市场表情扩展

export interface OneBotSegment<T = Record<string, any>> {
  type: OneBotSegmentType | string;
  data: T;
}

export interface OneBotTextSegment extends OneBotSegment<{ text: string }> {
  type: 'text';
}

export interface OneBotFaceSegment extends OneBotSegment<{ id: string; raw?: { faceIndex?: number; faceText?: string } }> {
  type: 'face';
}

export interface OneBotImageSegment extends OneBotSegment<{
  file: string;
  url?: string;
  sub_type?: number;
  file_size?: string | number;
  summary?: string;
  emoji_package_id?: number;
  emoji_id?: string;
}> {
  type: 'image';
}

export interface OneBotAtSegment extends OneBotSegment<{ qq: string | number }> {
  type: 'at';
}

export interface OneBotReplySegment extends OneBotSegment<{ id: string | number }> {
  type: 'reply';
}

export interface OneBotFileSegment extends OneBotSegment<{
  file: string;
  file_id: string;
  file_size?: string | number;
  busid?: number;
}> {
  type: 'file';
}

export interface OneBotForwardSegment extends OneBotSegment<{ id: string }> {
  type: 'forward';
}

export interface OneBotMessageEvent {
  post_type: 'message' | 'message_sent';
  message_type: OneBotMessageType;
  sub_type: string;
  message_id: number;
  message_seq?: number;
  real_id?: number;
  real_seq?: string;
  user_id: number | string;
  group_id?: number | string;
  group_name?: string;
  target_id?: number | string;
  sender: OneBotSender;
  message: OneBotSegment[];
  raw_message: string;
  font?: number;
  time: number;
  self_id: number | string;
}

export interface OneBotNoticeEvent {
  post_type: 'notice';
  notice_type: string;
  sub_type?: string;
  time: number;
  self_id: number | string;
  user_id?: number | string;
  sender_id?: number | string;
  target_id?: number | string;
  group_id?: number | string;
  operator_id?: number | string;
  message_id?: number | string;
  file?: {
    id: string;
    name: string;
    size: number;
    busid?: number;
    url?: string;
  };
  raw_info?: any[];
  likes?: Array<{ emoji_id?: string | number; id?: string | number; count?: number }>;
}

export interface OneBotRequestEvent {
  post_type: 'request';
  request_type: 'friend' | 'group' | string;
  user_id: number | string;
  comment?: string;
  flag: string;
  time: number;
  self_id: number | string;
  sub_type?: string;
  group_id?: number | string;
}

export interface OneBotMetaEvent {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  sub_type?: string;
  time: number;
  self_id: number | string;
  status?: any;
  interval?: number;
}

export interface OneBotActionResponse<T = any> {
  status: 'ok' | 'failed' | string;
  retcode: number;
  data: T;
  message?: string;
  wording?: string;
  echo?: string;
}
