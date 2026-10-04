/**
 * Provincias y cantones de Ecuador para el checkout mientras Dropi no habilite su API.
 * Sin ubicaciones nadie puede elegir dirección y no se puede comprar.
 *
 * Los ids empiezan en LOCAL_LOCATION_ID para no chocar con los de Dropi: cuando la sincronización
 * con Dropi funcione, `syncLocations` borra estos y deja solo los oficiales.
 * Es idempotente: se puede correr varias veces.
 * Uso: pnpm seed:locations
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env";
import { Location } from "../models/location.model";
import { LOCAL_LOCATION_ID } from "../services/dropiSync.service";

const ECUADOR: Record<string, string[]> = {
  Azuay: ["Cuenca", "Camilo Ponce Enríquez", "Chordeleg", "El Pan", "Girón", "Guachapala", "Gualaceo", "Nabón", "Oña", "Paute", "Pucará", "San Fernando", "Santa Isabel", "Sevilla de Oro", "Sígsig"],
  Bolívar: ["Guaranda", "Caluma", "Chillanes", "Chimbo", "Echeandía", "Las Naves", "San Miguel"],
  Cañar: ["Azogues", "Biblián", "Cañar", "Déleg", "El Tambo", "La Troncal", "Suscal"],
  Carchi: ["Tulcán", "Bolívar", "Espejo", "Mira", "Montúfar", "San Pedro de Huaca"],
  Chimborazo: ["Riobamba", "Alausí", "Chambo", "Chunchi", "Colta", "Cumandá", "Guamote", "Guano", "Pallatanga", "Penipe"],
  Cotopaxi: ["Latacunga", "La Maná", "Pangua", "Pujilí", "Salcedo", "Saquisilí", "Sigchos"],
  "El Oro": ["Machala", "Arenillas", "Atahualpa", "Balsas", "Chilla", "El Guabo", "Huaquillas", "Las Lajas", "Marcabelí", "Pasaje", "Piñas", "Portovelo", "Santa Rosa", "Zaruma"],
  Esmeraldas: ["Esmeraldas", "Atacames", "Eloy Alfaro", "Muisne", "Quinindé", "Río Verde", "San Lorenzo"],
  Galápagos: ["Puerto Baquerizo Moreno", "Puerto Ayora", "Puerto Villamil"],
  Guayas: ["Guayaquil", "Alfredo Baquerizo Moreno", "Balao", "Balzar", "Colimes", "Coronel Marcelino Maridueña", "Daule", "Durán", "El Empalme", "El Triunfo", "General Antonio Elizalde", "Isidro Ayora", "Lomas de Sargentillo", "Milagro", "Naranjal", "Naranjito", "Nobol", "Palestina", "Pedro Carbo", "Playas", "Salitre", "Samborondón", "Santa Lucía", "Simón Bolívar", "Yaguachi"],
  Imbabura: ["Ibarra", "Antonio Ante", "Cotacachi", "Otavalo", "Pimampiro", "San Miguel de Urcuquí"],
  Loja: ["Loja", "Calvas", "Catamayo", "Celica", "Chaguarpamba", "Espíndola", "Gonzanamá", "Macará", "Olmedo", "Paltas", "Pindal", "Puyango", "Quilanga", "Saraguro", "Sozoranga", "Zapotillo"],
  "Los Ríos": ["Babahoyo", "Baba", "Buena Fe", "Mocache", "Montalvo", "Palenque", "Puebloviejo", "Quevedo", "Quinsaloma", "Urdaneta", "Valencia", "Ventanas", "Vinces"],
  Manabí: ["Portoviejo", "Bolívar", "Chone", "El Carmen", "Flavio Alfaro", "Jama", "Jaramijó", "Jipijapa", "Junín", "Manta", "Montecristi", "Olmedo", "Paján", "Pedernales", "Pichincha", "Puerto López", "Rocafuerte", "San Vicente", "Santa Ana", "Sucre", "Tosagua", "24 de Mayo"],
  "Morona Santiago": ["Macas", "Gualaquiza", "Huamboya", "Limón Indanza", "Logroño", "Pablo Sexto", "Palora", "San Juan Bosco", "Santiago", "Sucúa", "Taisha", "Tiwintza"],
  Napo: ["Tena", "Archidona", "Carlos Julio Arosemena Tola", "El Chaco", "Quijos"],
  Orellana: ["Francisco de Orellana", "Aguarico", "La Joya de los Sachas", "Loreto"],
  Pastaza: ["Puyo", "Arajuno", "Mera", "Santa Clara"],
  Pichincha: ["Quito", "Cayambe", "Machachi", "Pedro Moncayo", "Pedro Vicente Maldonado", "Puerto Quito", "Rumiñahui", "San Miguel de los Bancos", "Sangolquí"],
  "Santa Elena": ["Santa Elena", "La Libertad", "Salinas"],
  "Santo Domingo de los Tsáchilas": ["Santo Domingo", "La Concordia"],
  Sucumbíos: ["Nueva Loja", "Cascales", "Cuyabeno", "Gonzalo Pizarro", "Putumayo", "Shushufindi", "Sucumbíos"],
  Tungurahua: ["Ambato", "Baños de Agua Santa", "Cevallos", "Mocha", "Patate", "Pelileo", "Quero", "Santiago de Píllaro", "Tisaleo"],
  "Zamora Chinchipe": ["Zamora", "Centinela del Cóndor", "Chinchipe", "El Pangui", "Nangaritza", "Palanda", "Paquisha", "Yacuambi", "Yantzaza"],
};

async function main() {
  await mongoose.connect(env.DB_URI);

  let provinceId = LOCAL_LOCATION_ID;
  let cityId = LOCAL_LOCATION_ID + 1000;
  let cities = 0;

  for (const [province, cantons] of Object.entries(ECUADOR)) {
    provinceId += 1;
    await Location.findOneAndUpdate(
      { kind: "province", dropiId: provinceId },
      { kind: "province", dropiId: provinceId, name: province, provinceId: null },
      { upsert: true },
    );
    for (const city of cantons) {
      cityId += 1;
      cities += 1;
      await Location.findOneAndUpdate(
        { kind: "city", dropiId: cityId },
        { kind: "city", dropiId: cityId, name: city, provinceId },
        { upsert: true },
      );
    }
  }

  console.log(`✔ ${Object.keys(ECUADOR).length} provincias y ${cities} ciudades`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
