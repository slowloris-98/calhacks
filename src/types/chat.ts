export interface Message {
  id: string;
  content: string;
  username: string;
  timestamp: number;
  isAI: boolean;
}

export interface User {
  id: string;
  username: string;
  roomId: string;
}

export interface Room {
  id: string;
  messages: Message[];
  users: User[];
  createdAt: number;
}

export interface JoinRoomData {
  roomId: string;
  username: string;
}

export interface SendMessageData {
  content: string;
  username: string;
  roomId: string;
}

export interface ServerToClientEvents {
  message: (message: Message) => void;
  userJoined: (user: User) => void;
  userLeft: (userId: string) => void;
  roomUsers: (users: User[]) => void;
  error: (error: string) => void;
}

export interface ClientToServerEvents {
  joinRoom: (data: JoinRoomData) => void;
  sendMessage: (data: SendMessageData) => void;
  leaveRoom: (roomId: string) => void;
}
