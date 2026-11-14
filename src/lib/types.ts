import type { ObjectId } from "mongodb";

export type Role = "admin" | "member";
export type StatusCategory = "backlog" | "unstarted" | "started" | "done" | "cancelled";
export type TaskType = "issue" | "feature";
export type Priority = 0 | 1 | 2 | 3; // none, low, medium, high

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
}
export interface OrgDoc {
  _id: ObjectId;
  name: string;
  slug: string;
  createdAt: Date;
}
export interface MembershipDoc {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  role: Role;
  createdAt: Date;
}
export interface ProjectDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  key: string;
  color: string;
  nextNumber: number;
  createdAt: Date;
}
export interface StatusDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  color: string;
  category: StatusCategory;
  order: number;
}
export interface TaskDoc {
  _id: ObjectId;
  orgId: ObjectId;
  projectId: ObjectId;
  number: number;
  title: string;
  description: string; // sanitised HTML from the editor
  type: TaskType;
  statusId: ObjectId;
  assigneeId: ObjectId | null;
  priority: Priority;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
export interface CommentDoc {
  _id: ObjectId;
  orgId: ObjectId;
  taskId: ObjectId;
  authorId: ObjectId;
  body: string;
  createdAt: Date;
}
export interface ActivityDoc {
  _id: ObjectId;
  orgId: ObjectId;
  taskId: ObjectId;
  actorId: ObjectId;
  kind: "created" | "status" | "assignee" | "priority" | "type" | "title" | "project";
  from?: string | null;
  to?: string | null;
  createdAt: Date;
}
export interface InviteDoc {
  _id: ObjectId;
  orgId: ObjectId;
  email: string;
  role: Role;
  token: string;
  invitedBy: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
}

/* ---- serialised shapes sent to the client ---- */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
}
export interface Project {
  id: string;
  name: string;
  key: string;
  color: string;
}
export interface Status {
  id: string;
  name: string;
  color: string;
  category: StatusCategory;
  order: number;
}
export interface Task {
  id: string;
  projectId: string;
  key: string; // e.g. WEB-12
  number: number;
  title: string;
  type: TaskType;
  statusId: string;
  assigneeId: string | null;
  priority: Priority;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface TaskDetail extends Task {
  description: string;
}
export interface FeedItem {
  id: string;
  kind: "comment" | ActivityDoc["kind"];
  actorId: string;
  body?: string;
  from?: string | null;
  to?: string | null;
  createdAt: string;
}
export interface Counts {
  my: number;
  all: number;
  projects: Record<string, number>;
}
