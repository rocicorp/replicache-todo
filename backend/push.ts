import { transact } from "./pg";
import {
  getCookie,
  getLastMutationID,
  setCookie,
  setLastMutationID,
} from "./data";
import { ReplicacheTransaction } from "./replicache-transaction";
import { mutators } from "../frontend/mutators";
import { z } from "zod";
import { parseIfDebug } from "@rocicorp/rails";
import Pusher from "pusher";

const mutationSchema = z.object({
  id: z.number(),
  name: z.string(),
  args: z.any(),
});

const pushRequestSchema = z.object({
  clientID: z.string(),
  mutations: z.array(mutationSchema),
});

export type Error = "SpaceNotFound";

export async function push(spaceID: string, requestBody: any) {
  console.log("Processing push", JSON.stringify(requestBody, null, ""));

  const push = parseIfDebug(pushRequestSchema, requestBody);

  const t0 = Date.now();
  await transact(async (executor) => {
    const prevVersion = await getCookie(executor, spaceID);
    if (prevVersion === undefined) {
      throw new Error(`Unknown space ${spaceID}`);
    }

    const nextVersion = prevVersion + 1;
    let lastMutationID =
      (await getLastMutationID(executor, push.clientID)) ?? 0;

    console.log("prevVersion: ", prevVersion);
    console.log("lastMutationID:", lastMutationID);

    const tx = new ReplicacheTransaction(
      executor,
      spaceID,
      push.clientID,
      nextVersion
    );

    for (let i = 0; i < push.mutations.length; i++) {
      const mutation = push.mutations[i];
      const expectedMutationID = lastMutationID + 1;

      if (mutation.id < expectedMutationID) {
        console.log(
          `Mutation ${mutation.id} has already been processed - skipping`
        );
        continue;
      }
      if (mutation.id > expectedMutationID) {
        console.warn(`Mutation ${mutation.id} is from the future - aborting`);
        break;
      }

      console.log("Processing mutation:", JSON.stringify(mutation, null, ""));

      const t1 = Date.now();
      const mutator = (mutators as any)[mutation.name];
      if (!mutator) {
        console.error(`Unknown mutator: ${mutation.name} - skipping`);
      }

      try {
        await mutator(tx, mutation.args);
      } catch (e) {
        console.error(
          `Error executing mutator: ${JSON.stringify(mutator)}: ${e}`
        );
      }

      lastMutationID = expectedMutationID;
      console.log("Processed mutation in", Date.now() - t1);
    }

    await Promise.all([
      setLastMutationID(executor, push.clientID, lastMutationID),
      setCookie(executor, spaceID, nextVersion),
      tx.flush(),
    ]);

    if (
      process.env.NEXT_PUBLIC_PUSHER_APP_ID &&
      process.env.NEXT_PUBLIC_PUSHER_KEY &&
      process.env.NEXT_PUBLIC_PUSHER_SECRET &&
      process.env.NEXT_PUBLIC_PUSHER_CLUSTER
    ) {
      const startPoke = Date.now();

      const pusher = new Pusher({
        appId: process.env.NEXT_PUBLIC_PUSHER_APP_ID,
        key: process.env.NEXT_PUBLIC_PUSHER_KEY,
        secret: process.env.NEXT_PUBLIC_PUSHER_SECRET,
        cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
        useTLS: true,
      });

      await pusher.trigger("default", "poke", {});
      console.log("Poke took", Date.now() - startPoke);
    } else {
      console.log("Not poking because Pusher is not configured");
    }
  });

  console.log("Processed all mutations in", Date.now() - t0);
}
