import { describe, it, expect } from 'vitest'
import { tgValidateInitData } from './tgInitData'

describe('tgValidateInitData', () => {
  const botId = '2201403107';
  const testPublicKey = '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec';
  const exampleInitData = 'user=%7B%22id%22%3A5001146408%2C%22first_name%22%3A%22H%22%2C%22last_name%22%3A%22Test%22%2C%22language_code%22%3A%22en%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Fa-ttgme.stel.com%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2FOhOF3_f4QY8PWlRZI2aG2sy66VMZw_ys9efvhvle_eCWj2zP8Vbb6pLs5d1Lij1w.svg%22%7D&chat_instance=3909909964740758046&chat_type=sender&auth_date=1759930604&signature=i8jsEp2yuO2tlldICxBscMG3xX-zUPznGZVsDNy0tz9GRVx9vxBWjTEt4BSMSa42TaOO0r2yGWBN0a1v9bVRAg&hash=1582635705fd71ffb8bee16062f38965550b5d9a4f85f387b2ea72067c57d45a';

  it('should validate the example init data', async () => {
    const isValid = await tgValidateInitData(exampleInitData, botId, testPublicKey)
    expect(isValid).toBe(true)
  })

  it('should fail validation if any byte is modified', async () => {
    // Modify a single character in the data
    const modifiedData = exampleInitData.replace('5001146408', '5001146409')
    const isValid = await tgValidateInitData(modifiedData, botId, testPublicKey)
    expect(isValid).toBe(false)
  })
})
