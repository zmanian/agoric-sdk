/* eslint-disable no-use-before-define */
import harden from '@agoric/harden';
import makePromise from '@agoric/make-promise';
import { makeZoeHelpers, defaultAcceptanceMsg } from './helpers/zoeHelpers';

/**  EDIT THIS CONTRACT WITH YOUR OWN BUSINESS LOGIC */

/**
 * This contract is like the simpleExchange contract. The SimpleExchange uses
 * Asset and Price as its Issuer roles. In usage, they're somewhat symmetrical.
 * Participants will be buying or selling in both directions.
 *
 * { offer: { 'Asset', simoleans(5) }, want: { 'Price', quatloos(3) } }
 * { offer: { 'Price', quatloos(8) }, want: { 'Asset', simoleans(3) } }
 *
 * The asset specified under 'want' for a particular order is treated as an
 * exact amount to be exchanged, while the amount specified as 'offer' is a
 * limit that may be improved on. This simple exchange does not partially fill
 * orders.
 */
export const makeContract = harden(zoe => {
  const PRICE = 'Price';
  const ASSET = 'Asset';

  let sellInviteHandles = [];
  let buyInviteHandles = [];
  let nextChangePromise = makePromise();

  const {
    rejectOffer,
    checkIfOfferRules,
    swap,
    canTradeWith,
    getActiveOffers,
    assertRoleNames,
  } = makeZoeHelpers(zoe);

  assertRoleNames(harden([ASSET, PRICE]));

  function flattenRule(r) {
    const roleName = Object.getOwnPropertyNames(r)[0];
    const struct = {};
    struct[roleName] = r[roleName].extent;
    return harden(struct);
  }

  function flattenOffer(o) {
    return harden([
      flattenRule(o.offerRules.want),
      flattenRule(o.offerRules.offer),
    ]);
  }

  function flattenOrders(offerHandles) {
    const result = zoe
      .getOffers(zoe.getOfferStatuses(offerHandles).active)
      .map(offer => flattenOffer(offer));
    return result;
  }

  function getBookOrders() {
    return {
      changed: nextChangePromise.p,
      buys: flattenOrders(buyInviteHandles),
      sells: flattenOrders(sellInviteHandles),
    };
  }

  function getOffer(inviteHandle) {
    for (const handle of [...sellInviteHandles, ...buyInviteHandles]) {
      if (inviteHandle === handle) {
        return flattenOffer(getActiveOffers([inviteHandle])[0]);
      }
    }
    return 'not an active offer';
  }

  // This is a really simple update protocol, which merely provides a promise
  // in getBookOrders() that will resolve when the state changes. Clients
  // subscribe to the promise and are notified at some future point. A much
  // nicer protocol is in https://github.com/Agoric/agoric-sdk/issues/253
  function bookOrdersChanged() {
    nextChangePromise.res();
    nextChangePromise = makePromise();
  }

  function swapIfCanTrade(inviteHandles, inviteHandle) {
    for (const iHandle of inviteHandles) {
      if (canTradeWith(inviteHandle, iHandle)) {
        bookOrdersChanged();
        return swap(inviteHandle, iHandle);
      }
    }
    bookOrdersChanged();
    return defaultAcceptanceMsg;
  }

  const makeInvite = () => {
    const seat = harden({
      // This code might be modified to support immediate_or_cancel. Current
      // implementation is effectively fill_or_kill.
      addOrder: () => {
        const buyAssetForPrice = harden({
          offer: [PRICE],
          want: [ASSET],
        });
        const sellAssetForPrice = harden({
          offer: [ASSET],
          want: [PRICE],
        });
        if (checkIfOfferRules(inviteHandle, sellAssetForPrice)) {
          // Save the valid offer and try to match

          // IDEA: to implement matching against the best price, the orders
          // should be sorted. (We'd also want to allow partial matches.)
          sellInviteHandles.push(inviteHandle);
          buyInviteHandles = [...zoe.getOfferStatuses(buyInviteHandles).active];
          return swapIfCanTrade(buyInviteHandles, inviteHandle);
          /* eslint-disable no-else-return */
        } else if (checkIfOfferRules(inviteHandle, buyAssetForPrice)) {
          // Save the valid offer and try to match
          buyInviteHandles.push(inviteHandle);
          sellInviteHandles = [
            ...zoe.getOfferStatuses(sellInviteHandles).active,
          ];
          return swapIfCanTrade(sellInviteHandles, inviteHandle);
        } else {
          // Eject because the offer must be invalid
          return rejectOffer(inviteHandle);
        }
      },
    });
    const { invite, inviteHandle } = zoe.makeInvite(seat);
    return { invite, inviteHandle };
  };

  return harden({
    invite: makeInvite(),
    publicAPI: { makeInvite, getBookOrders, getOffer },
  });
});
