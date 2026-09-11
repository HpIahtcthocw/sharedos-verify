declare module "supertest" {
  import * as express from "express";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Test = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Response = any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export default function request(app: any): Test;
}
