#include "PrototypeGameMode.h"
#include "PrototypeCharacter.h"

APrototypeGameMode::APrototypeGameMode()
{
	DefaultPawnClass = APrototypeCharacter::StaticClass();
}
