import { GhostRequestRegisterTelegram, GhostResponse, RegisterTelegramResponseData } from '../params';
import { type GhostContext } from '../context';
import { tgValidateInitData } from '@monorepo/core/sandboxed';

export async function handleRegisterTelegram(request: GhostRequestRegisterTelegram, ctx: GhostContext): Promise<GhostResponse<RegisterTelegramResponseData>> {
    const isValid = await tgValidateInitData(request.initDataRaw, ctx.tgBotId, ctx.tgPubKey);
    if( ! isValid ) {
        throw new Error("TG Auth Data Not Valid!");
    }
    const params = new URLSearchParams(request.initDataRaw);
    const userJson = params.get('user');
    if( userJson === null ) {
        throw new Error("No 'user' in initData!");
    }
    const user = JSON.parse(userJson);
    console.log('Validated user is', user);

    // We can only register telegram users with a username
    const username:string|undefined = user.username;
    if( username === undefined || typeof username !== "string" ) {
        throw new Error("No 'username' field in initData.user!");
    }

    // Issue the user a keypair
    const mgr = await ctx.getManager();
    const userKey = mgr.getUserKeypair(username);
    return {
        ok: true,
        data: {
            telegram: {
                username: username,
                privateKey: userKey.privateKey
            }
        }
    }
}
