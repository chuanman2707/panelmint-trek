import admin from './admin';
import airport from './airport';
import budget from './budget';
import common from './common';
import dashboard from './dashboard';
import day from './day';
import dayplan from './dayplan';
import inspector from './inspector';
import journey from './journey';
import map from './map';
import members from './members';
import mobileSettings from './mobileSettings';
import mobileTrip from './mobileTrip';
import nav from './nav';
import packing from './packing';
import places from './places';
import planner from './planner';
import roadtrip from './roadtrip';
import reservations from './reservations';
import settings from './settings';
import todo from './todo';
import transport from './transport';
import trip from './trip';
import trips from './trips';
import undo from './undo';
import vacay from './vacay';

const locale = {
  ...common,
  ...trips,
  ...nav,
  ...dashboard,
  ...roadtrip,
  ...settings,
  ...admin,
  ...dayplan,
  ...vacay,
  ...trip,
  ...places,
  ...inspector,
  ...reservations,
  ...airport,
  ...map,
  ...budget,
  ...packing,
  ...members,
  ...planner,
  ...day,
  ...undo,
  ...todo,
  ...journey,
  ...transport,
  ...mobileTrip,
  ...mobileSettings,
};
export default locale;
