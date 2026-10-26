import { test, expect } from '../../fixtures/testFixtures';
import { loadTestData } from '../../utils/testData';
import { randomString } from '../../utils/helpers';

type Location = { name: string; address: string; code: string };

test.describe('Location management', () => {
  let locationName: string;

  test.afterEach(async ({ locationPage }) => {
    if (locationName) {
      await locationPage.deleteLocation(locationName);
    }
  });

  test('user can add a new location', async ({ locationPage }) => {
    const locations = loadTestData<Location[]>('locations.json');
    const location = locations[0];
    locationName = randomString(location.name);
    const uniqueCode = randomString(location.code);

    await locationPage.goto();
    await locationPage.addLocation(locationName, location.address, uniqueCode);

    await expect(locationPage.locationTable).toContainText(locationName);
  });
});
