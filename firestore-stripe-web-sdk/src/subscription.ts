/*
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FirebaseApp } from "@firebase/app";
import {
  doc,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  FirestoreDataConverter,
  getDoc,
  getFirestore,
  QueryDocumentSnapshot,
  Timestamp,
} from "@firebase/firestore";
import { StripePaymentsError } from ".";
import { StripePayments } from "./init";
import { getCurrentUser } from "./user";
import { checkNonEmptyString } from "./utils";

/**
 * Interface of a Stripe Subscription stored in the app database.
 */
export interface Subscription {
  /**
   * A future date in UTC format at which the subscription will automatically get canceled.
   */
  readonly cancelAt: string | null;

  /**
   * If `true`, the subscription has been canceled by the user and will be deleted at the end
   * of the billing period.
   */
  readonly cancelAtPeriodEnd: boolean;

  /**
   * If the subscription has been canceled, the date of that cancellation as a UTC timestamp.
   * If the subscription was canceled with {@link Subscription.cancelAtPeriodEnd}, this field
   * will still reflect the date of the initial cancellation request, not the end of the
   * subscription period when the subscription is automatically moved to a canceled state.
   */
  readonly canceledAt: string | null;

  /**
   * The date when the subscription was created as a UTC timestamp.
   */
  readonly created: string;

  /**
   * End of the current period that the subscription has been invoiced for as a UTC timestamp.
   * At the end of the period, a new invoice will be created.
   */
  readonly currentPeriodEnd: string;

  /**
   * Start of the current period that the subscription has been invoiced for as a UTC timestamp.
   */
  readonly currentPeriodStart: string;

  /**
   * If the subscription has ended, the date the subscription ended as a UTC timestamp.
   */
  readonly endedAt: string | null;

  /**
   * Unique Stripe subscription ID.
   */
  readonly id: string;

  /**
   * Set of extra key-value pairs attached to the subscription object.
   */
  readonly metadata: { [name: string]: string };

  /**
   * Stripe price ID associated with this subscription.
   */
  readonly priceId: string;

  /**
   * Array of product ID and price ID pairs. If multiple recurring prices were provided to the
   * checkout session (e.g. via `lineItems`) this array holds all recurring prices for this
   * subscription. The first element of this array always corresponds to the
   * {@link Subscription.priceId} and {@link Subscription.productId} fields on the subscription.
   */
  readonly prices: Array<{ productId: string; priceId: string }>;

  /**
   * Stripe product ID associated with this subscription.
   */
  readonly productId: string;

  /**
   * Quantity of items purchased with this subscription.
   */
  readonly quantity: number | null;

  /**
   * The Firebae role that can be assigned to the user with this subscription.
   */
  readonly role: string | null;

  /**
   * The status of the subscription object
   */
  readonly status: SubscriptionState;

  /**
   * A link to the subscription in the Stripe dashboard.
   */
  readonly stripeLink: string;

  /**
   * If the subscription has a trial, the end date of that trial as a UTC timestamp.
   */
  readonly trialEnd: string | null;

  /**
   * If the subscription has a trial, the start date of that trial as a UTC timestamp.
   */
  readonly trialStart: string | null;

  /**
   * Firebase Auth UID of the user that created the subscription.
   */
  readonly uid: string;

  readonly [propName: string]: any;
}

/**
 * Possible states a subscription can be in.
 */
export type SubscriptionState =
  | "active"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "trialing"
  | "unpaid";

/**
 * Retrieves an existing Stripe subscription for the currently signed in user from the database.
 *
 * @param payments - A valid {@link StripePayments} object.
 * @param subscriptionId - ID of the subscription to retrieve.
 * @returns Resolves with a Subscription object if found. Rejects if the specified subscription ID
 *  does not exist, or if the user is not signed in.
 */
export function getCurrentUserSubscription(
  payments: StripePayments,
  subscriptionId: string
): Promise<Subscription> {
  checkNonEmptyString(
    subscriptionId,
    "subscriptionId must be a non-empty string."
  );
  return getCurrentUser(payments).then((uid: string) => {
    const dao: SubscriptionDAO = getOrInitSubscriptionDAO(payments);
    return dao.getSubscription(uid, subscriptionId);
  });
}

/**
 * Internal interface for all database interactions pertaining to Stripe subscriptions. Exported
 * for testing.
 *
 * @internal
 */
export interface SubscriptionDAO {
  getSubscription(uid: string, subscriptionId: string): Promise<Subscription>;
}

const SUBSCRIPTION_CONVERTER: FirestoreDataConverter<Subscription> = {
  toFirestore: () => {
    throw new Error("Not implemented for readonly Subscription type.");
  },
  fromFirestore: (snapshot: QueryDocumentSnapshot): Subscription => {
    const data: DocumentData = snapshot.data();
    const refs: DocumentReference[] = data.prices;
    const prices: Array<{ productId: string; priceId: string }> = refs.map(
      (priceRef: DocumentReference) => {
        return {
          productId: priceRef.parent.parent!.id,
          priceId: priceRef.id,
        };
      }
    );

    return {
      cancelAt: toNullableUTCDateString(data.cancel_at),
      cancelAtPeriodEnd: data.cancel_at_period_end,
      canceledAt: toNullableUTCDateString(data.canceled_at),
      created: toUTCDateString(data.created),
      currentPeriodStart: toUTCDateString(data.current_period_start),
      currentPeriodEnd: toUTCDateString(data.current_period_end),
      endedAt: toNullableUTCDateString(data.ended_at),
      id: snapshot.id,
      metadata: data.metadata ?? {},
      priceId: (data.price as DocumentReference).id,
      prices,
      productId: (data.product as DocumentReference).id,
      quantity: data.quantity ?? null,
      role: data.role ?? null,
      status: data.status,
      stripeLink: data.stripeLink,
      trialEnd: toNullableUTCDateString(data.trial_end),
      trialStart: toNullableUTCDateString(data.trial_start),
      uid: snapshot.ref.parent.parent!.id,
    };
  },
};

function toNullableUTCDateString(timestamp: Timestamp | null): string | null {
  if (timestamp === null) {
    return null;
  }

  return toUTCDateString(timestamp);
}

function toUTCDateString(timestamp: Timestamp): string {
  return timestamp.toDate().toUTCString();
}

class FirestoreSubscriptionDAO implements SubscriptionDAO {
  private readonly firestore: Firestore;

  constructor(app: FirebaseApp, private readonly customersCollection: string) {
    this.firestore = getFirestore(app);
  }

  public async getSubscription(
    uid: string,
    subscriptionId: string
  ): Promise<Subscription> {
    const snap: QueryDocumentSnapshot<Subscription> =
      await this.getSubscriptionSnapshotIfExists(uid, subscriptionId);
    return snap.data();
  }

  private async getSubscriptionSnapshotIfExists(
    uid: string,
    subscriptionId: string
  ): Promise<QueryDocumentSnapshot<Subscription>> {
    const subscriptionRef: DocumentReference<Subscription> = doc(
      this.firestore,
      this.customersCollection,
      uid,
      "subscriptions",
      subscriptionId
    ).withConverter(SUBSCRIPTION_CONVERTER);
    const snapshot: DocumentSnapshot<Subscription> = await this.queryFirestore(
      () => getDoc(subscriptionRef)
    );
    if (!snapshot.exists()) {
      throw new StripePaymentsError(
        "not-found",
        `No subscription found with the ID: ${subscriptionId} for user: ${uid}`
      );
    }

    return snapshot;
  }

  private async queryFirestore<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new StripePaymentsError(
        "internal",
        "Unexpected error while querying Firestore",
        error
      );
    }
  }
}

const SUBSCRIPTION_DAO_KEY = "subscription-dao" as const;

function getOrInitSubscriptionDAO(payments: StripePayments): SubscriptionDAO {
  let dao: SubscriptionDAO | null =
    payments.getComponent<SubscriptionDAO>(SUBSCRIPTION_DAO_KEY);
  if (!dao) {
    dao = new FirestoreSubscriptionDAO(
      payments.app,
      payments.customersCollection
    );
    setSubscriptionDAO(payments, dao);
  }

  return dao;
}

/**
 * Internal API for registering a {@link SubscriptionDAO} instance with {@link StripePayments}.
 * Exported for testing.
 *
 * @internal
 */
export function setSubscriptionDAO(
  payments: StripePayments,
  dao: SubscriptionDAO
): void {
  payments.setComponent(SUBSCRIPTION_DAO_KEY, dao);
}
